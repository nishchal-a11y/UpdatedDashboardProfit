"""Build the project profitability EDA datasets from the raw source files.

Reads Projects.csv, TimeSheet_Row_data.csv, the employee master workbook,
monthly payroll, and salary revisions, then writes EDA CSVs plus a
manifest describing the timesheet window and every data quality counter.
"""

import argparse
import calendar
import csv
import json
import re
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from xml.etree import ElementTree


ROOT = Path(__file__).parent
SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NAMESPACE = {"m": SHEET_NS}

PROJECTS_FILE = "Projects.csv"
TIMESHEET_FILE = "TimeSheet_Row_data.csv"
EMPLOYEES_FILE = "All Employees - Finanshels.com.xlsx"
PAYROLL_FILE = "All Employees Month-on-Month YTD Report_Jan 2026 - Aug 2026 _.xlsx"
SALARY_REVISIONS_FILE = "Emp_Salary_Revisions_Finanshels.com_.xlsx"
INR_TO_AED = 0.042

OUT_PROJECT_HOURS = "EDA_Project_Hours.csv"
OUT_EMPLOYEE_UTILISATION = "EDA_Employee_Utilization.csv"
OUT_INTERNAL_TIME = "EDA_Internal_Time.csv"
OUT_UNALLOCATED = "EDA_Unallocated_Hours.csv"
OUT_UNALLOCATED_NO_DEPT = "EDA_Unallocated_Hours_no_dept.csv"
OUT_PERIOD_MISMATCH = "EDA_Period_Mismatch.csv"
OUT_DATA_QUALITY = "EDA_Data_Quality.csv"
OUT_SERVICE_MIX = "EDA_Service_Mix.csv"
OUT_ALLOCATION_AUDIT = "EDA_Allocation_Audit.csv"
OUT_EMPLOYEE_COST = "EDA_Employee_Cost.csv"
OUT_SALARY_REVISIONS = "EDA_Salary_Revisions.csv"
OUT_PAYROLL_COST_MONTHLY = "EDA_Payroll_Cost_Monthly.csv"
OUT_CLIENT_SUMMARY = "EDA_Client_Summary.csv"
OUT_PEOPLE_SUMMARY = "EDA_People_Summary.csv"
OUT_TRENDS = "EDA_Trends.csv"
OUT_MANIFEST = "EDA_Manifest.json"

UNALLOCATED_ID = "__unallocated__"
# Highest priority wins when duplicate project rows disagree on status.
STATUS_PRIORITY = ["current", "overdue", "next_month", "on-hold", "completed", "future", "archived", "deleted"]


# --------------------------------------------------------------------------- text


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "").strip())


def clean_key(value):
    return re.sub(r"[\s.\-_]+", "", clean_text(value)).casefold()


def clean_email(value):
    return clean_text(value).casefold()


def parse_number(value):
    text = clean_text(value).replace(",", "")
    text = re.sub(r"[^0-9.\-]", "", text)
    if not text or text in {"-", ".", "-."}:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def parse_hours(value):
    """Timesheet hours arrive either as a decimal or as HH:MM:SS."""
    text = clean_text(value)
    if not text:
        return 0.0
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return float(text)
    parts = text.split(":")
    if len(parts) != 3:
        return 0.0
    try:
        return float(parts[0] or 0) + float(parts[1] or 0) / 60 + float(parts[2] or 0) / 3600
    except ValueError:
        return 0.0


TIMESHEET_DATE_FORMATS = ("%d %b, %Y %H:%M:%S", "%d %b, %Y")
PROJECT_DATE_FORMATS = ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y")


def parse_date(value, formats):
    text = clean_text(value)
    if not text:
        return None
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def iso(value):
    return value.isoformat() if value else ""


def mix_string(counter):
    """Compact 'key:hours' summary, ordered by hours descending."""
    parts = [f"{key}:{round(value, 2):g}" for key, value in sorted(counter.items(), key=lambda item: -item[1]) if value]
    return "|".join(parts)


# --------------------------------------------------------------------------- readers


def read_csv(name):
    with (ROOT / name).open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def column_letters_to_index(reference):
    letters = re.match(r"[A-Za-z]+", reference or "")
    if not letters:
        return None
    index = 0
    for char in letters.group(0).upper():
        index = index * 26 + (ord(char) - 64)
    return index - 1


def read_xlsx_rows(path):
    """Read the first worksheet into a list of rows, honouring sparse cells."""
    with zipfile.ZipFile(path) as workbook:
        shared = []
        if "xl/sharedStrings.xml" in workbook.namelist():
            shared_root = ElementTree.fromstring(workbook.read("xl/sharedStrings.xml"))
            shared = ["".join(node.text or "" for node in item.iter(f"{{{SHEET_NS}}}t")) for item in shared_root.findall("m:si", NAMESPACE)]
        sheet_names = [name for name in workbook.namelist() if name.startswith("xl/worksheets/sheet")]
        sheet = ElementTree.fromstring(workbook.read(sorted(sheet_names)[0]))
        rows = []
        for row in sheet.findall(".//m:row", NAMESPACE):
            values = []
            for position, cell in enumerate(row.findall("m:c", NAMESPACE)):
                index = column_letters_to_index(cell.get("r")) 
                index = position if index is None else index
                if cell.get("t") == "inlineStr":
                    inline = cell.find("m:is", NAMESPACE)
                    text = "".join(node.text or "" for node in inline.iter(f"{{{SHEET_NS}}}t")) if inline is not None else ""
                else:
                    node = cell.find("m:v", NAMESPACE)
                    text = "" if node is None else node.text or ""
                    if cell.get("t") == "s" and text:
                        text = shared[int(text)]
                while len(values) <= index:
                    values.append("")
                values[index] = text
            rows.append(values)
    return rows


def rows_to_dicts(rows, header_index):
    headers = [clean_text(value) for value in rows[header_index]]
    records = []
    for row in rows[header_index + 1:]:
        record = {header: (row[index] if index < len(row) else "") for index, header in enumerate(headers) if header}
        if any(clean_text(value) for value in record.values()):
            records.append(record)
    return records


def find_header_row(rows, keywords):
    """Locate the header row by looking for any of the expected column keywords."""
    for index, row in enumerate(rows[:12]):
        lowered = [clean_text(value).casefold() for value in row]
        if sum(1 for cell in lowered if cell) >= 2 and any(keyword in cell for cell in lowered for keyword in keywords):
            return index
    return 0


def read_employees():
    rows = read_xlsx_rows(ROOT / EMPLOYEES_FILE)
    return rows_to_dicts(rows, find_header_row(rows, ("full name", "email")))


# --------------------------------------------------------------------------- lookups


def employee_lookups(employees):
    by_email = {}
    by_name = {}
    for employee in employees:
        name = clean_text(employee.get("Full Name"))
        if not name:
            continue
        entry = {
            "name": name,
            "email": clean_email(employee.get("Email")),
            "employee_number": clean_text(employee.get("Employee Number")),
            "reporting_to": clean_text(employee.get("Reporting To")),
            "department": clean_text(employee.get("Department")),
            "job_title": clean_text(employee.get("Job Title")),
        }
        if entry["email"] and entry["email"] not in by_email:
            by_email[entry["email"]] = entry
        key = clean_key(name)
        if key and key not in by_name:
            by_name[key] = entry
    return by_email, by_name


def excel_serial_date(value):
    """Convert an Excel date serial to a calendar date."""
    number = parse_number(value)
    return (datetime(1899, 12, 30) + timedelta(days=number)).date() if number else None


def read_payroll_records():
    path = ROOT / PAYROLL_FILE
    if not path.exists():
        return []
    rows = read_xlsx_rows(path)
    records = rows_to_dicts(rows, find_header_row(rows, ("employee name", "payroll month", "total")))
    result = []
    for record in records:
        headers = {clean_text(key).casefold(): key for key in record}
        employee_name = clean_text(record.get(headers.get("employee name", "")))
        payroll_month = clean_text(record.get(headers.get("payroll month", "")))
        if not employee_name or not payroll_month or payroll_month.casefold() == "totals":
            continue
        try:
            month = datetime.strptime(payroll_month, "%b - %Y").date().replace(day=1)
        except ValueError:
            continue
        result.append({
            "employee_id": clean_text(record.get(headers.get("employee number", ""))),
            "employee": employee_name,
            "month": month,
            "total_inr": parse_number(record.get(headers.get("total", ""))),
        })
    return result


def read_salary_revisions():
    path = ROOT / SALARY_REVISIONS_FILE
    if not path.exists():
        return []
    rows = read_xlsx_rows(path)
    records = rows_to_dicts(rows, find_header_row(rows, ("employee name", "previous regular salary", "effective from")))
    result = []
    for record in records:
        headers = {clean_text(key).casefold(): key for key in record}
        employee_name = clean_text(record.get(headers.get("employee name", "")))
        employee_id = clean_text(record.get(headers.get("employee number", "")))
        effective = excel_serial_date(record.get(headers.get("effective from", "")))
        status = clean_text(record.get(headers.get("approval status", ""))).casefold()
        if not employee_name or not effective or status != "approved":
            continue
        result.append({
            "employee_id": employee_id,
            "employee": employee_name,
            "effective_from": effective,
            "previous_regular_salary_inr": parse_number(record.get(headers.get("previous regular salary", ""))),
            "revised_regular_salary_inr": parse_number(record.get(headers.get("revised regular salary", ""))),
        })
    return result


def status_rank(status):
    text = clean_text(status).casefold()
    return STATUS_PRIORITY.index(text) if text in STATUS_PRIORITY else len(STATUS_PRIORITY)


def project_lookup(projects):
    """Aggregate Projects.csv by project-name key.

    The previous build kept the first row per key and discarded the rest, which
    silently dropped duplicate rows and their revenue.
    """
    lookup = {}
    for item in projects:
        name = clean_text(item.get("name"))
        key = clean_key(name)
        if not key:
            continue
        client = clean_text(item.get("client_legal_name"))
        start = parse_date(item.get("startDate"), PROJECT_DATE_FORMATS)
        end = parse_date(item.get("endDate"), PROJECT_DATE_FORMATS)
        deadline = parse_date(item.get("deadline"), PROJECT_DATE_FORMATS)
        record = lookup.get(key)
        if record is None:
            record = lookup[key] = {
                "project_id": key,
                "project": name,
                "clients": set(),
                "client": client,
                "client_id": clean_key(client) or "unknown_client",
                "task": clean_text(item.get("service_name")),
                "tl": clean_text(item.get("team_lead_name")),
                "tl_email": clean_email(item.get("team_lead_email")),
                "manager": clean_text(item.get("project_manager_name")),
                "contract_revenue": 0.0,
                # What the old first-wins lookup would have kept, so the recovery is measurable.
                "first_row_revenue": parse_number(item.get("amount")),
                "source_rows": 0,
                "status": clean_text(item.get("status")),
                "frequency": clean_text(item.get("serviceFrequency")),
                "revenue_type": clean_text(item.get("revenueType")),
                "service_type": clean_text(item.get("serviceType")),
                "start": start,
                "end": end,
                "deadline": deadline,
            }
        record["contract_revenue"] += parse_number(item.get("amount"))
        record["source_rows"] += 1
        if client:
            record["clients"].add(client)
        if status_rank(item.get("status")) < status_rank(record["status"]):
            record["status"] = clean_text(item.get("status"))
        if clean_text(item.get("revenueType")).casefold() == "invoiced":
            record["revenue_type"] = "invoiced"
        for field, value in (("task", item.get("service_name")), ("tl", item.get("team_lead_name")), ("frequency", item.get("serviceFrequency")), ("service_type", item.get("serviceType")), ("manager", item.get("project_manager_name"))):
            if not record[field]:
                record[field] = clean_text(value)
        if start and (record["start"] is None or start < record["start"]):
            record["start"] = start
        if end and (record["end"] is None or end > record["end"]):
            record["end"] = end
        if deadline and (record["deadline"] is None or deadline > record["deadline"]):
            record["deadline"] = deadline
    for record in lookup.values():
        record["client_name_conflict"] = "yes" if len(record["clients"]) > 1 else "no"
        if not record["client"] and record["clients"]:
            record["client"] = sorted(record["clients"])[0]
            record["client_id"] = clean_key(record["client"]) or "unknown_client"
    return lookup


def apply_revenue_recognition(projects, window_start, window_end):
    """Effort-based recognition.

    Projects whose contract window overlaps the timesheet window are prorated by
    the overlapping share of their span. Projects with no overlap, or no dates at
    all, recognise full contract revenue because the work demonstrably happened
    inside the window.
    """
    for record in projects.values():
        start, end = record["start"], record["end"]
        revenue = record["contract_revenue"]
        if start and end and end >= start and end >= window_start and start <= window_end:
            span_days = (end - start).days + 1
            overlap_days = (min(end, window_end) - max(start, window_start)).days + 1
            share = overlap_days / span_days if span_days > 0 else 1.0
            record["in_window_revenue"] = revenue * share
            record["revenue_basis"] = "Prorated"
            record["window_coverage_pct"] = round(share * 100, 4)
            record["overlap_days"] = overlap_days
        else:
            record["in_window_revenue"] = revenue
            record["revenue_basis"] = "Undated full" if not (start and end) else "Out-of-window full"
            record["window_coverage_pct"] = 100.0
            record["overlap_days"] = 0
    return projects


def unallocated_project():
    return {
        "project_id": UNALLOCATED_ID,
        "project": "Unallocated internal time",
        "client": "Unallocated / Overhead",
        "client_id": UNALLOCATED_ID,
        "clients": set(),
        "client_name_conflict": "no",
        "task": "Unallocated",
        "tl": "Unassigned",
        "tl_email": "",
        "manager": "",
        "contract_revenue": 0.0,
        "first_row_revenue": 0.0,
        "in_window_revenue": 0.0,
        "revenue_basis": "No revenue",
        "window_coverage_pct": 0.0,
        "overlap_days": 0,
        "source_rows": 0,
        "status": "n/a",
        "frequency": "n/a",
        "revenue_type": "n/a",
        "service_type": "n/a",
        "start": None,
        "end": None,
        "deadline": None,
    }


# --------------------------------------------------------------------------- build


def build(requested_window=None):
    project_rows = read_csv(PROJECTS_FILE)
    timesheet_rows = read_csv(TIMESHEET_FILE)
    employees = read_employees()
    by_email, by_name = employee_lookups(employees)
    projects = project_lookup(project_rows)

    entries = []
    for item in timesheet_rows:
        name = clean_text(item.get("submitted_by_name"))
        email = clean_email(item.get("submitted_by_email"))
        # Email is the primary key because names differ between the two systems.
        email_hit = by_email.get(email)
        name_hit = by_name.get(clean_key(name))
        person = email_hit or name_hit
        reporting_to = (email_hit or {}).get("reporting_to") or (name_hit or {}).get("reporting_to") or ""
        if email_hit and email_hit["reporting_to"]:
            tl_source = "Email match"
        elif name_hit and name_hit["reporting_to"]:
            tl_source = "Name match"
        else:
            tl_source = "No match"
        date = parse_date(item.get("date_submitted_for"), TIMESHEET_DATE_FORMATS)
        entries.append({
            "employee": name,
            "employee_key": clean_key(name),
            "email": email,
            "employee_number": (person or {}).get("employee_number", ""),
            "employee_master_name": (person or {}).get("name", ""),
            "in_master": person is not None,
            "reporting_to": reporting_to,
            "tl_source": tl_source,
            "department": (email_hit or {}).get("department") or (name_hit or {}).get("department") or "",
            "hours": parse_hours(item.get("hours")),
            "date": date,
            "status": clean_text(item.get("status")),
            "day_type": clean_text(item.get("day_type")),
            "work_type": clean_text(item.get("work_type")),
            "project_key": clean_key(item.get("project_name")),
            "project_name": clean_text(item.get("project_name")),
            "task_name": clean_text(item.get("task_name")),
            "general_task": clean_text(item.get("general_task_name")),
        })

    # Trends always describe the whole history, so they keep the unfiltered rows.
    all_entries = list(entries)
    dates = [entry["date"] for entry in entries if entry["date"]]
    data_start, data_end = (min(dates), max(dates)) if dates else (None, None)
    requested_start, requested_end = requested_window or (None, None)
    if requested_start or requested_end:
        # An explicit window keeps only dated rows inside it, so hours, revenue
        # recognition and the allocation history all describe the same period.
        low = requested_start or data_start or datetime.min.date()
        high = requested_end or data_end or datetime.max.date()
        entries = [entry for entry in entries if entry["date"] and low <= entry["date"] <= high]
        window_start, window_end = low, high
    else:
        window_start, window_end = data_start, data_end
    window_days = (window_end - window_start).days + 1 if window_start and window_end else 0
    apply_revenue_recognition(projects, window_start or datetime.min.date(), window_end or datetime.max.date())

    actual, internal = [], []
    for entry in entries:
        project = projects.get(entry["project_key"]) if entry["project_key"] else None
        if project:
            actual.append({**entry, "project": project})
        else:
            internal.append(entry)

    # Historical portfolios drive how internal time is spread onto client work.
    employee_history = defaultdict(lambda: defaultdict(float))
    tl_history = defaultdict(lambda: defaultdict(float))
    department_history = defaultdict(lambda: defaultdict(float))
    for row in actual:
        if row["hours"] <= 0:
            continue
        employee_history[row["employee_key"]][row["project"]["project_id"]] += row["hours"]
        tl_history[clean_key(row["project"]["tl"])][row["project"]["project_id"]] += row["hours"]
        if row["department"]:
            department_history[clean_key(row["department"])][row["project"]["project_id"]] += row["hours"]

    records = defaultdict(lambda: {"contributors": defaultdict(lambda: {
        "actual": 0.0, "allocated": 0.0, "approved": 0.0, "nonapproved": 0.0, "nonworking": 0.0,
        "status_mix": Counter(), "day_mix": Counter(), "tasks": Counter(),
    })})

    def add(project, amount, method, entry, reporting_to):
        record = records[project["project_id"]]
        record["project"] = project
        key = (entry["employee"] or "Unknown", reporting_to or project["tl"] or "Unassigned", method)
        bucket = record["contributors"][key]
        bucket["actual" if method == "Actual" else "allocated"] += amount
        if clean_text(entry["status"]).casefold() == "approved":
            bucket["approved"] += amount
        else:
            bucket["nonapproved"] += amount
        if clean_text(entry["day_type"]).casefold() != "working_day":
            bucket["nonworking"] += amount
        bucket["status_mix"][entry["status"] or "unknown"] += amount
        bucket["day_mix"][entry["day_type"] or "unknown"] += amount
        label = entry["task_name"] or entry["general_task"]
        if label:
            bucket["tasks"][label] += amount

    for row in actual:
        add(row["project"], row["hours"], "Actual", row, row["reporting_to"])

    def portfolio_for(entry):
        """Pick the portfolio that should absorb this person's internal time.

        Rungs run most to least specific: their own delivery mix, their own
        portfolio if they lead projects, their reporting line's portfolio, then
        their department's pool. Returns (portfolio, method, reason); reason is
        set only when every rung fails.
        """
        personal = employee_history.get(entry["employee_key"])
        if personal and sum(personal.values()) > 0:
            return personal, "Employee Weighted Allocation", ""
        own = tl_history.get(entry["employee_key"])
        if own and sum(own.values()) > 0:
            return own, "TL Self Portfolio Allocation", ""
        reporting = tl_history.get(clean_key(entry["reporting_to"])) if entry["reporting_to"] else None
        if reporting and sum(reporting.values()) > 0:
            return reporting, "AM Weighted Allocation", ""
        pool = department_history.get(clean_key(entry["department"])) if entry["department"] else None
        if pool and sum(pool.values()) > 0:
            return pool, "Department Weighted Allocation", ""
        if not entry["in_master"]:
            return None, "", "Not in employee master (no reporting line or department)"
        if not entry["department"]:
            return None, "", "No department on the employee record"
        return None, "", f"Department '{entry['department']}' books no client hours"

    unallocated = unallocated_project()
    unallocated_register = defaultdict(lambda: {"hours": 0.0, "entries": 0, "categories": Counter()})
    allocation_audit = defaultdict(lambda: {"allocated_hours": 0.0, "donor_hours": 0.0})

    for entry in internal:
        if entry["hours"] <= 0:
            continue
        portfolio, method, reason = portfolio_for(entry)
        if not portfolio:
            projects[UNALLOCATED_ID] = unallocated
            add(unallocated, entry["hours"], "Unallocated", entry, entry["reporting_to"])
            register = unallocated_register[(entry["employee"], entry["email"], entry["reporting_to"], reason, entry["in_master"])]
            register["hours"] += entry["hours"]
            register["entries"] += 1
            register["categories"][entry["general_task"] or "Uncategorised"] += entry["hours"]
            continue
        total = sum(portfolio.values())
        for project_id, donor_hours in portfolio.items():
            share = entry["hours"] * donor_hours / total
            add(projects[project_id], share, method, entry, entry["reporting_to"])
            audit = allocation_audit[(entry["employee"], method, project_id)]
            audit["allocated_hours"] += share
            audit["donor_hours"] = donor_hours

    return {
        "projects": projects,
        "records": records,
        "entries": entries,
        "all_entries": all_entries,
        "actual": actual,
        "internal": internal,
        "employees": employees,
        "by_email": by_email,
        "by_name": by_name,
        "unallocated_register": unallocated_register,
        "allocation_audit": allocation_audit,
        "employee_history": employee_history,
        "window_start": window_start,
        "window_end": window_end,
        "window_days": window_days,
        "data_start": data_start,
        "data_end": data_end,
        "window_custom": bool(requested_start or requested_end),
        "project_rows": project_rows,
    }


# --------------------------------------------------------------------------- outputs


PROJECT_HOURS_FIELDS = [
    "client_id", "client_name", "project_id", "project_name", "task_name", "service_name",
    "project_team_lead", "reporting_to_tl", "submitted_by", "allocation_type", "allocation_method",
    "project_revenue", "contract_revenue", "in_window_revenue", "revenue_basis", "window_coverage_pct",
    "project_status", "service_frequency", "revenue_type", "service_type",
    "project_start", "project_end", "deadline", "duplicate_source_rows", "client_name_conflict",
    "project_hours", "allocated_hours", "unallocated_hours", "total_hours",
    "approved_hours", "nonapproved_hours", "nonworking_hours", "timesheet_status_mix", "day_type_mix", "top_tasks",
]


def write_csv(name, fields, rows):
    with (ROOT / name).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def build_project_hours(data):
    rows = []
    for project_id, record in data["records"].items():
        project = record["project"]
        contributors = sorted(record["contributors"].items(), key=lambda item: (item[0][0], item[0][1], item[0][2]))
        for index, ((employee, reporting_to, method), amounts) in enumerate(contributors):
            actual_hours = amounts["actual"]
            allocated_hours = amounts["allocated"] if method != "Unallocated" else 0.0
            unallocated_hours = amounts["allocated"] if method == "Unallocated" else 0.0
            total = actual_hours + allocated_hours + unallocated_hours
            rows.append({
                "client_id": project["client_id"],
                "client_name": project["client"],
                "project_id": project_id,
                "project_name": project["project"],
                "task_name": project["task"],
                "service_name": project["task"],
                "project_team_lead": project["tl"] or "Unassigned",
                "reporting_to_tl": reporting_to,
                "submitted_by": employee,
                "allocation_type": "Actual" if method == "Actual" else "Unallocated" if method == "Unallocated" else "Allocated",
                "allocation_method": method,
                # Revenue is carried once per project, on its first contributor row.
                "project_revenue": f"{project['in_window_revenue']:.2f}" if index == 0 else "0.00",
                "contract_revenue": f"{project['contract_revenue']:.2f}" if index == 0 else "0.00",
                "in_window_revenue": f"{project['in_window_revenue']:.2f}" if index == 0 else "0.00",
                "revenue_basis": project["revenue_basis"],
                "window_coverage_pct": f"{project['window_coverage_pct']:.2f}",
                "project_status": project["status"] or "unknown",
                "service_frequency": project["frequency"] or "unknown",
                "revenue_type": project["revenue_type"] or "unknown",
                "service_type": project["service_type"] or "unknown",
                "project_start": iso(project["start"]),
                "project_end": iso(project["end"]),
                "deadline": iso(project["deadline"]),
                "duplicate_source_rows": project["source_rows"],
                "client_name_conflict": project["client_name_conflict"],
                "project_hours": f"{actual_hours:.6f}",
                "allocated_hours": f"{allocated_hours:.6f}",
                "unallocated_hours": f"{unallocated_hours:.6f}",
                "total_hours": f"{total:.6f}",
                "approved_hours": f"{amounts['approved']:.6f}",
                "nonapproved_hours": f"{amounts['nonapproved']:.6f}",
                "nonworking_hours": f"{amounts['nonworking']:.6f}",
                "timesheet_status_mix": mix_string(amounts["status_mix"]),
                "day_type_mix": mix_string(amounts["day_mix"]),
                "top_tasks": mix_string(Counter(dict(amounts["tasks"].most_common(3)))),
            })
    return rows


def build_employee_utilisation(data, cost_by_key, cost_by_name):
    stats = defaultdict(lambda: {
        "email": "", "employee_number": "", "master_name": "", "reporting_to": "", "department": "", "in_master": False, "tl_source": "",
        "client_hours": 0.0, "internal_hours": 0.0, "leave_entries": 0, "entries": 0,
        "nonapproved_hours": 0.0, "nonworking_hours": 0.0, "projects": set(),
    })
    for entry in data["entries"]:
        record = stats[entry["employee"] or "Unknown"]
        record["email"] = record["email"] or entry["email"]
        record["employee_number"] = record["employee_number"] or entry["employee_number"]
        record["master_name"] = record["master_name"] or entry["employee_master_name"]
        record["reporting_to"] = record["reporting_to"] or entry["reporting_to"]
        record["tl_source"] = record["tl_source"] or entry["tl_source"]
        record["department"] = record["department"] or entry["department"]
        record["in_master"] = record["in_master"] or entry["in_master"]
        record["entries"] += 1
        if entry["project_key"] and entry["project_key"] in data["projects"]:
            record["client_hours"] += entry["hours"]
            record["projects"].add(entry["project_key"])
        else:
            record["internal_hours"] += entry["hours"]
        if clean_text(entry["status"]).casefold() != "approved":
            record["nonapproved_hours"] += entry["hours"]
        if clean_text(entry["day_type"]).casefold() != "working_day":
            record["nonworking_hours"] += entry["hours"]
            record["leave_entries"] += 1

    unallocated_by_employee = defaultdict(float)
    for (employee, _email, _reporting, _reason, _in_master), value in data["unallocated_register"].items():
        unallocated_by_employee[employee] += value["hours"]

    fields = ["employee", "employee_number", "email", "department", "reporting_to", "tl_source", "in_employee_master", "client_hours", "internal_hours",
              "allocated_out_hours", "unallocated_hours", "total_logged_hours", "utilization_pct", "internal_pct",
              "projects_touched", "timesheet_entries", "nonapproved_hours", "nonworking_hours",
              "window_cost_inr", "window_cost_aed", "covered_payroll_days", "revision_adjusted_months",
              "cost_per_hour_absorption", "cost_source"]
    rows = []
    for employee, record in sorted(stats.items()):
        total = record["client_hours"] + record["internal_hours"]
        unallocated = unallocated_by_employee.get(employee, 0.0)
        payroll_rows = cost_by_key.get(record["employee_number"], [])
        cost_source = "employee number" if payroll_rows else ""
        if not payroll_rows:
            for candidate in (record["master_name"], employee):
                payroll_rows = cost_by_name.get(clean_key(candidate), [])
                if payroll_rows:
                    cost_source = "employee name"
                    break
        window_cost_inr, covered_days, revision_adjusted_months = payroll_cost_for_window(
            payroll_rows, data["window_start"], data["window_end"])
        window_cost_aed = window_cost_inr * INR_TO_AED
        rows.append({
            "employee": employee,
            "employee_number": record["employee_number"],
            "email": record["email"],
            "department": record["department"],
            "reporting_to": record["reporting_to"],
            "tl_source": record["tl_source"],
            "in_employee_master": "yes" if record["in_master"] else "no",
            "client_hours": f"{record['client_hours']:.6f}",
            "internal_hours": f"{record['internal_hours']:.6f}",
            "allocated_out_hours": f"{record['internal_hours'] - unallocated:.6f}",
            "unallocated_hours": f"{unallocated:.6f}",
            "total_logged_hours": f"{total:.6f}",
            "utilization_pct": f"{record['client_hours'] / total * 100:.2f}" if total else "0.00",
            "internal_pct": f"{record['internal_hours'] / total * 100:.2f}" if total else "0.00",
            "projects_touched": len(record["projects"]),
            "timesheet_entries": record["entries"],
            "nonapproved_hours": f"{record['nonapproved_hours']:.6f}",
            "nonworking_hours": f"{record['nonworking_hours']:.6f}",
            "window_cost_inr": f"{window_cost_inr:.2f}" if covered_days else "",
            "window_cost_aed": f"{window_cost_aed:.2f}" if covered_days else "",
            "covered_payroll_days": covered_days,
            "revision_adjusted_months": revision_adjusted_months,
            "cost_per_hour_absorption": f"{window_cost_aed / total:.6f}" if covered_days and total else "",
            "cost_source": cost_source if covered_days else "uncovered",
        })
    return fields, rows


def build_internal_time(data):
    groups = defaultdict(lambda: {"hours": 0.0, "entries": 0})
    for entry in data["internal"]:
        key = (entry["general_task"] or "Uncategorised", entry["employee"] or "Unknown", entry["reporting_to"] or "Unassigned", entry["department"] or "Unknown")
        groups[key]["hours"] += entry["hours"]
        groups[key]["entries"] += 1
    total = sum(value["hours"] for value in groups.values()) or 1
    fields = ["internal_category", "employee", "reporting_to", "department", "hours", "entries", "share_of_internal_pct"]
    rows = [{
        "internal_category": category,
        "employee": employee,
        "reporting_to": reporting_to,
        "department": department,
        "hours": f"{value['hours']:.6f}",
        "entries": value["entries"],
        "share_of_internal_pct": f"{value['hours'] / total * 100:.4f}",
    } for (category, employee, reporting_to, department), value in sorted(groups.items(), key=lambda item: -item[1]["hours"])]
    return fields, rows


def build_unallocated(data):
    fields = ["employee", "email", "reporting_to", "in_employee_master", "reason", "hours", "entries", "top_categories"]
    rows = [{
        "employee": employee,
        "email": email,
        "reporting_to": reporting_to,
        "in_employee_master": "yes" if in_master else "no",
        "reason": reason,
        "hours": f"{value['hours']:.6f}",
        "entries": value["entries"],
        "top_categories": mix_string(Counter(dict(value["categories"].most_common(3)))),
    } for (employee, email, reporting_to, reason, in_master), value in sorted(data["unallocated_register"].items(), key=lambda item: -item[1]["hours"])]
    return fields, rows


def build_unallocated_no_dept(data, base_rows):
    """Base register plus employees whose internal was spread by the department pool.

    Written as a sibling CSV so the dashboard can swap it in when the
    Department allocation toggle is turned off. The base rows stay first,
    followed by one row per person returned from the department rung.
    """
    fields = ["employee", "email", "reporting_to", "in_employee_master", "reason", "hours", "entries", "top_categories"]
    dept_employees = defaultdict(lambda: {"hours": 0.0, "entries": 0, "categories": Counter(),
                                          "email": "", "reporting_to": "", "in_master": False})
    for (employee, method, _project_id), value in data["allocation_audit"].items():
        if method != "Department Weighted Allocation":
            continue
        dept_employees[employee]["hours"] += value["allocated_hours"]
    for entry in data["internal"]:
        record = dept_employees.get(entry["employee"])
        if record is None:
            continue
        record["email"] = record["email"] or entry["email"]
        record["reporting_to"] = record["reporting_to"] or entry["reporting_to"]
        record["in_master"] = record["in_master"] or entry["in_master"]
        record["entries"] += 1
        record["categories"][entry["general_task"] or "Uncategorised"] += entry["hours"]
    extras = [{
        "employee": employee,
        "email": record["email"],
        "reporting_to": record["reporting_to"],
        "in_employee_master": "yes" if record["in_master"] else "no",
        "reason": "Department pool disabled · hours returned to unallocated",
        "hours": f"{record['hours']:.6f}",
        "entries": record["entries"],
        "top_categories": mix_string(Counter(dict(record["categories"].most_common(3)))),
    } for employee, record in sorted(dept_employees.items(), key=lambda item: -item[1]["hours"])]
    return fields, list(base_rows) + extras


def build_period_mismatch(data):
    fields = ["project_id", "project_name", "client_name", "project_team_lead", "revenue_basis", "project_status",
              "service_frequency", "project_start", "project_end", "deadline", "contract_revenue",
              "in_window_revenue", "total_hours", "window_coverage_pct"]
    rows = []
    for project_id, record in data["records"].items():
        project = record["project"]
        if project["revenue_basis"] == "Prorated" or project_id == UNALLOCATED_ID:
            continue
        hours = sum(value["actual"] + value["allocated"] for value in record["contributors"].values())
        rows.append({
            "project_id": project_id,
            "project_name": project["project"],
            "client_name": project["client"],
            "project_team_lead": project["tl"] or "Unassigned",
            "revenue_basis": project["revenue_basis"],
            "project_status": project["status"],
            "service_frequency": project["frequency"],
            "project_start": iso(project["start"]),
            "project_end": iso(project["end"]),
            "deadline": iso(project["deadline"]),
            "contract_revenue": f"{project['contract_revenue']:.2f}",
            "in_window_revenue": f"{project['in_window_revenue']:.2f}",
            "total_hours": f"{hours:.6f}",
            "window_coverage_pct": f"{project['window_coverage_pct']:.2f}",
        })
    return fields, sorted(rows, key=lambda row: -float(row["contract_revenue"]))


def build_service_mix(data):
    groups = defaultdict(lambda: {"projects": set(), "hours": 0.0, "actual": 0.0, "allocated": 0.0, "contract": 0.0, "in_window": 0.0, "clients": set()})
    for project_id, record in data["records"].items():
        project = record["project"]
        group = groups[project["task"] or "Unclassified"]
        group["projects"].add(project_id)
        group["clients"].add(project["client"])
        group["contract"] += project["contract_revenue"]
        group["in_window"] += project["in_window_revenue"]
        for value in record["contributors"].values():
            group["actual"] += value["actual"]
            group["allocated"] += value["allocated"]
            group["hours"] += value["actual"] + value["allocated"]
    fields = ["service_name", "projects", "clients", "actual_hours", "allocated_hours", "total_hours",
              "contract_revenue", "in_window_revenue", "revenue_per_hour"]
    rows = [{
        "service_name": service,
        "projects": len(value["projects"]),
        "clients": len(value["clients"]),
        "actual_hours": f"{value['actual']:.6f}",
        "allocated_hours": f"{value['allocated']:.6f}",
        "total_hours": f"{value['hours']:.6f}",
        "contract_revenue": f"{value['contract']:.2f}",
        "in_window_revenue": f"{value['in_window']:.2f}",
        "revenue_per_hour": f"{value['in_window'] / value['hours']:.4f}" if value["hours"] else "0.0000",
    } for service, value in sorted(groups.items(), key=lambda item: -item[1]["in_window"])]
    return fields, rows


def build_allocation_audit(data):
    totals = defaultdict(float)
    for (employee, method, _project_id), value in data["allocation_audit"].items():
        totals[(employee, method)] += value["donor_hours"]
    fields = ["employee", "allocation_method", "donor_project_id", "donor_project_name", "donor_client",
              "donor_history_hours", "weight_pct", "allocated_hours"]
    rows = []
    for (employee, method, project_id), value in data["allocation_audit"].items():
        project = data["projects"].get(project_id, {})
        denominator = totals[(employee, method)] or 1
        rows.append({
            "employee": employee,
            "allocation_method": method,
            "donor_project_id": project_id,
            "donor_project_name": project.get("project", ""),
            "donor_client": project.get("client", ""),
            "donor_history_hours": f"{value['donor_hours']:.6f}",
            "weight_pct": f"{value['donor_hours'] / denominator * 100:.4f}",
            "allocated_hours": f"{value['allocated_hours']:.6f}",
        })
    return fields, sorted(rows, key=lambda row: (row["employee"], -float(row["allocated_hours"])))


def concentration(values):
    """Herfindahl index over a set of hour figures, 0 to 1.

    1 means every hour sat on a single project or client; a value near 0 means
    the hours were spread evenly across many. Used as the concentration signal
    on both summary pages.
    """
    total = sum(values)
    if total <= 0:
        return 0.0
    return sum((value / total) ** 2 for value in values)


def revenue_by_project(data):
    """Project id to (contract, in-window) revenue for the projects with hours."""
    return {project_id: (record["project"]["contract_revenue"], record["project"]["in_window_revenue"])
            for project_id, record in data["records"].items()}


CLIENT_SUMMARY_FIELDS = [
    "client_id", "client_name", "projects", "team_leads", "people", "services",
    "actual_hours", "allocated_hours", "unallocated_hours", "total_hours", "delivered_hours", "approved_hours",
    "contract_revenue", "in_window_revenue", "revenue_per_delivered_hour",
    "top_project", "top_project_hours", "top_team_lead", "top_service", "project_status_mix", "project_hhi",
]


def build_client_summary(data, project_hours):
    """One row per client, folded from the emitted contributor rows.

    Folding the rows that were already emitted, rather than re-walking the
    records, keeps client hours equal to emitted hours by construction. Revenue
    is read from the project records instead, because the emitted rows carry it
    once per project rather than on every row.
    """
    groups = defaultdict(lambda: {
        "client_name": "", "projects": Counter(), "team_leads": Counter(), "services": Counter(),
        "statuses": Counter(), "people": set(),
        "actual": 0.0, "allocated": 0.0, "unallocated": 0.0, "approved": 0.0,
    })
    for row in project_hours:
        group = groups[row["client_id"]]
        group["client_name"] = group["client_name"] or row["client_name"]
        total = float(row["total_hours"])
        group["projects"][row["project_name"]] += total
        group["team_leads"][row["project_team_lead"]] += total
        group["services"][row["service_name"] or "Unclassified"] += total
        group["statuses"][row["project_status"]] += total
        group["people"].add(row["submitted_by"])
        group["actual"] += float(row["project_hours"])
        group["allocated"] += float(row["allocated_hours"])
        group["unallocated"] += float(row["unallocated_hours"])
        group["approved"] += float(row["approved_hours"])

    revenue = defaultdict(lambda: [0.0, 0.0])
    for project_id, (contract, in_window) in revenue_by_project(data).items():
        client_id = data["records"][project_id]["project"]["client_id"]
        revenue[client_id][0] += contract
        revenue[client_id][1] += in_window

    rows = []
    for client_id, group in groups.items():
        total = group["actual"] + group["allocated"] + group["unallocated"]
        # Unallocated hours earn nothing, so they stay out of the revenue rate,
        # matching how the dashboard derives revenue per delivered hour.
        delivered = group["actual"] + group["allocated"]
        contract, in_window = revenue.get(client_id, [0.0, 0.0])
        top_project, top_project_hours = (group["projects"].most_common(1) or [("", 0.0)])[0]
        rows.append({
            "client_id": client_id,
            "client_name": group["client_name"],
            "projects": len(group["projects"]),
            "team_leads": len(group["team_leads"]),
            "people": len(group["people"]),
            "services": len(group["services"]),
            "actual_hours": f"{group['actual']:.6f}",
            "allocated_hours": f"{group['allocated']:.6f}",
            "unallocated_hours": f"{group['unallocated']:.6f}",
            "total_hours": f"{total:.6f}",
            "delivered_hours": f"{delivered:.6f}",
            "approved_hours": f"{group['approved']:.6f}",
            "contract_revenue": f"{contract:.2f}",
            "in_window_revenue": f"{in_window:.2f}",
            "revenue_per_delivered_hour": f"{in_window / delivered:.4f}" if delivered else "0.0000",
            "top_project": top_project,
            "top_project_hours": f"{top_project_hours:.6f}",
            "top_team_lead": (group["team_leads"].most_common(1) or [("", 0.0)])[0][0],
            "top_service": (group["services"].most_common(1) or [("", 0.0)])[0][0],
            "project_status_mix": mix_string(group["statuses"]),
            "project_hhi": f"{concentration(group['projects'].values()):.4f}",
        })
    return CLIENT_SUMMARY_FIELDS, sorted(rows, key=lambda row: -float(row["in_window_revenue"]))


PEOPLE_SUMMARY_FIELDS = [
    "employee", "email", "department", "reporting_to", "in_employee_master",
    "clients_touched", "projects_touched", "team_leads_touched",
    "top_client", "top_client_hours", "top_client_share_pct", "client_hhi",
    "top_projects", "max_hours_project", "max_hours_project_hours",
    "top_team_lead", "top_team_lead_hours",
    "client_hours", "internal_hours", "actual_hours", "allocated_hours", "unallocated_hours",
    "total_hours", "delivered_hours", "utilization_pct", "nonapproved_hours",
    "revenue_share", "revenue_per_delivered_hour", "window_cost_inr", "window_cost_aed",
    "revision_adjusted_months", "cost_per_hour_absorption",
]


def build_people_summary(data, project_hours, utilisation_rows):
    """One row per person: who they worked for, on what, and for how much.

    The utilisation file is the spine, so the row count and per-person hours
    stay identical to it. Revenue is attributed the same way the dashboard does
    it, a person's share of a project's hours times that project's in-window
    revenue, so a person's revenue here equals their revenue in the drill-down.
    """
    stats = defaultdict(lambda: {
        "clients": Counter(), "projects": Counter(), "team_leads": Counter(),
        "actual": 0.0, "allocated": 0.0, "unallocated": 0.0, "nonapproved": 0.0,
        "project_hours": Counter(),
    })
    project_totals = Counter()
    for row in project_hours:
        employee = row["submitted_by"]
        record = stats[employee]
        total = float(row["total_hours"])
        record["clients"][row["client_name"]] += total
        record["projects"][row["project_name"]] += total
        record["team_leads"][row["project_team_lead"]] += total
        record["project_hours"][row["project_id"]] += total
        record["actual"] += float(row["project_hours"])
        record["allocated"] += float(row["allocated_hours"])
        record["unallocated"] += float(row["unallocated_hours"])
        record["nonapproved"] += float(row["nonapproved_hours"])
        project_totals[row["project_id"]] += total

    revenue = revenue_by_project(data)
    rows = []
    for utilisation in utilisation_rows:
        employee = utilisation["employee"]
        record = stats.get(employee)
        if record is None:
            record = stats[employee]
        total = record["actual"] + record["allocated"] + record["unallocated"]
        delivered = record["actual"] + record["allocated"]
        revenue_share = sum(revenue.get(project_id, (0.0, 0.0))[1] * hours / project_totals[project_id]
                            for project_id, hours in record["project_hours"].items()
                            if project_totals[project_id])
        top_client, top_client_hours = (record["clients"].most_common(1) or [("", 0.0)])[0]
        top_project, top_project_hours = (record["projects"].most_common(1) or [("", 0.0)])[0]
        top_lead, top_lead_hours = (record["team_leads"].most_common(1) or [("", 0.0)])[0]
        rows.append({
            "employee": employee,
            "email": utilisation["email"],
            "department": utilisation["department"],
            "reporting_to": utilisation["reporting_to"],
            "in_employee_master": utilisation["in_employee_master"],
            "clients_touched": len(record["clients"]),
            "projects_touched": len(record["projects"]),
            "team_leads_touched": len(record["team_leads"]),
            "top_client": top_client,
            "top_client_hours": f"{top_client_hours:.6f}",
            "top_client_share_pct": f"{top_client_hours / total * 100:.2f}" if total else "0.00",
            "client_hhi": f"{concentration(record['clients'].values()):.4f}",
            "top_projects": mix_string(Counter(dict(record["projects"].most_common(3)))),
            "max_hours_project": top_project,
            "max_hours_project_hours": f"{top_project_hours:.6f}",
            "top_team_lead": top_lead,
            "top_team_lead_hours": f"{top_lead_hours:.6f}",
            # Client hours here are the hours that landed on client projects,
            # which includes the internal time allocation spread onto them. The
            # utilisation file's client_hours is the narrower actual-only figure.
            "client_hours": utilisation["client_hours"],
            "internal_hours": utilisation["internal_hours"],
            "actual_hours": f"{record['actual']:.6f}",
            "allocated_hours": f"{record['allocated']:.6f}",
            "unallocated_hours": f"{record['unallocated']:.6f}",
            "total_hours": f"{total:.6f}",
            "delivered_hours": f"{delivered:.6f}",
            "utilization_pct": utilisation["utilization_pct"],
            "nonapproved_hours": f"{record['nonapproved']:.6f}",
            "revenue_share": f"{revenue_share:.2f}",
            "revenue_per_delivered_hour": f"{revenue_share / delivered:.4f}" if delivered else "0.0000",
            "window_cost_inr": utilisation["window_cost_inr"],
            "window_cost_aed": utilisation["window_cost_aed"],
            "revision_adjusted_months": utilisation["revision_adjusted_months"],
            "cost_per_hour_absorption": utilisation["cost_per_hour_absorption"],
        })
    return PEOPLE_SUMMARY_FIELDS, sorted(rows, key=lambda row: -float(row["total_hours"]))


def build_data_quality(data, quality):
    fields = ["check", "category", "severity", "count", "value", "detail"]
    return fields, [{
        "check": item[0], "category": item[1], "severity": item[2],
        "count": item[3], "value": f"{item[4]:.2f}" if isinstance(item[4], float) else item[4], "detail": item[5],
    } for item in quality]


# --------------------------------------------------------------------------- cost


def salary_revision_schedule(month, revisions):
    month_end = date(month.year, month.month, calendar.monthrange(month.year, month.month)[1])
    applicable = sorted((row for row in revisions if row["effective_from"] <= month_end),
                        key=lambda row: row["effective_from"])
    if not applicable:
        return None

    prior = [row for row in applicable if row["effective_from"] < month]
    in_month = [row for row in applicable if month <= row["effective_from"] <= month_end]
    if prior:
        current_salary = prior[-1]["revised_regular_salary_inr"]
    elif in_month:
        current_salary = in_month[0]["previous_regular_salary_inr"]
    else:
        return None

    previous_salary = in_month[0]["previous_regular_salary_inr"] if in_month else applicable[-1]["previous_regular_salary_inr"]
    segments = []
    cursor = month
    for revision in in_month:
        effective = revision["effective_from"]
        if effective > cursor:
            segments.append((cursor, effective - timedelta(days=1), current_salary))
        current_salary = revision["revised_regular_salary_inr"]
        cursor = effective
    if cursor <= month_end:
        segments.append((cursor, month_end, current_salary))

    month_days = (month_end - month).days + 1
    revised_month_cost = sum(
        salary / 12 * ((segment_end - segment_start).days + 1) / month_days
        for segment_start, segment_end, salary in segments
    )
    return {
        "segments": segments,
        "previous_salary": previous_salary,
        "revised_salary": current_salary,
        "previous_month_cost": previous_salary / 12,
        "revised_month_cost": revised_month_cost,
        "effective_from": applicable[-1]["effective_from"],
    }


def payroll_month_cost(row, window_start, window_end):
    month = row["month"]
    month_end = date(month.year, month.month, calendar.monthrange(month.year, month.month)[1])
    if not window_start or not window_end:
        return None
    overlap_start = max(window_start, month)
    overlap_end = min(window_end, month_end)
    if overlap_start > overlap_end:
        return None

    overlap_days = (overlap_end - overlap_start).days + 1
    month_days = (month_end - month).days + 1
    schedule = salary_revision_schedule(month, row.get("salary_revisions", []))
    previous_month_cost = schedule["previous_month_cost"] if schedule else 0.0
    revised_month_cost = schedule["revised_month_cost"] if schedule else 0.0
    tolerance = max(2.0, previous_month_cost * 0.01)
    revision_applied = bool(schedule
        and abs(row["total_inr"] - previous_month_cost) <= tolerance
        and abs(revised_month_cost - previous_month_cost) > 0.01)

    if revision_applied:
        cost = sum(
            salary / 12 * ((min(overlap_end, segment_end) - max(overlap_start, segment_start)).days + 1) / month_days
            for segment_start, segment_end, salary in schedule["segments"]
            if max(overlap_start, segment_start) <= min(overlap_end, segment_end)
        )
        calculated_month_cost = revised_month_cost
    else:
        cost = row["total_inr"] * overlap_days / month_days
        calculated_month_cost = row["total_inr"]

    return {
        "cost_inr": cost,
        "covered_days": overlap_days,
        "revision_applied": revision_applied,
        "calculated_month_cost_inr": calculated_month_cost,
        "schedule": schedule,
    }


def payroll_cost_for_window(payroll_rows, window_start, window_end):
    cost = 0.0
    covered_days = 0
    adjusted_months = 0
    for row in payroll_rows:
        result = payroll_month_cost(row, window_start, window_end)
        if not result:
            continue
        cost += result["cost_inr"]
        covered_days += result["covered_days"]
        adjusted_months += int(result["revision_applied"])
    return cost, covered_days, adjusted_months


def build_payroll_cost_monthly(payroll_rows):
    fields = ["employee_number", "employee", "payroll_month", "payroll_total_inr",
              "calculated_month_cost_inr", "calculated_month_cost_aed", "revision_applied",
              "revision_effective_from", "previous_regular_salary_inr", "revised_regular_salary_inr",
              "previous_month_cost_inr", "revised_month_cost_inr", "source", "decision"]
    rows = []
    for payroll in payroll_rows:
        month = payroll["month"]
        month_end = date(month.year, month.month, calendar.monthrange(month.year, month.month)[1])
        result = payroll_month_cost(payroll, month, month_end)
        schedule = result["schedule"]
        applied = result["revision_applied"]
        rows.append({
            "employee_number": payroll["employee_id"],
            "employee": payroll["employee"],
            "payroll_month": month.isoformat(),
            "payroll_total_inr": f"{payroll['total_inr']:.2f}",
            "calculated_month_cost_inr": f"{result['calculated_month_cost_inr']:.2f}",
            "calculated_month_cost_aed": f"{result['calculated_month_cost_inr'] * INR_TO_AED:.2f}",
            "revision_applied": "yes" if applied else "no",
            "revision_effective_from": iso(schedule["effective_from"]) if schedule else "",
            "previous_regular_salary_inr": f"{schedule['previous_salary']:.2f}" if schedule else "",
            "revised_regular_salary_inr": f"{schedule['revised_salary']:.2f}" if schedule else "",
            "previous_month_cost_inr": f"{schedule['previous_month_cost']:.2f}" if schedule else "",
            "revised_month_cost_inr": f"{schedule['revised_month_cost']:.2f}" if schedule else "",
            "source": f"Carried forward from {payroll['carried_from'].strftime('%b %Y')}" if payroll.get("carried_from") else "Payroll export",
            "decision": (
                "Applied effective-date revision to stale prior-salary Total" if applied
                else "Retained payroll Total; revision already reflected or Total differs from prior salary"
                if schedule else "Retained payroll Total; no approved revision"
            ),
        })
    return fields, rows


TREND_FIELDS = [
    "grain", "period_key", "label", "period_start", "period_end", "calendar_days", "data_days", "partial",
    "timesheet_rows", "logged_hours", "client_hours", "internal_hours", "approved_hours",
    "projects_active", "clients_active", "people_active",
    "revenue", "revenue_prorated", "revenue_effort",
    "payroll_cost_inr", "payroll_cost_aed", "payroll_days_covered", "costed_hours", "costed_people",
]


def trend_periods(start, end):
    """Calendar months and Monday-start weeks spanning [start, end], clipped to the data."""
    periods = []
    cursor = date(start.year, start.month, 1)
    while cursor <= end:
        last = date(cursor.year, cursor.month, calendar.monthrange(cursor.year, cursor.month)[1])
        periods.append(("month", cursor.strftime("%Y-%m"), cursor.strftime("%b %Y"), cursor, last))
        cursor = last + timedelta(days=1)
    cursor = start - timedelta(days=start.weekday())
    while cursor <= end:
        last = cursor + timedelta(days=6)
        iso_year, iso_week, _ = cursor.isocalendar()
        periods.append(("week", f"{iso_year}-W{iso_week:02d}", f"W{iso_week:02d} · {cursor.strftime('%d %b')}", cursor, last))
        cursor = last + timedelta(days=1)
    return periods


def build_trends(data, cost_by_key, cost_by_name):
    """Month-on-month and week-on-week series over the full timesheet history.

    The selected window is ignored on purpose: a trend needs every period. Revenue
    is decomposed so the periods sum to the full-history in-window revenue: dated
    contracts are prorated by calendar days that fall in each period, and undated
    or out-of-window contracts are spread by the share of their hours logged in it.
    """
    entries = [entry for entry in data["all_entries"] if entry["date"]]
    if not entries:
        return TREND_FIELDS, []
    projects = data["projects"]
    start = min(entry["date"] for entry in entries)
    end = max(entry["date"] for entry in entries)

    project_hours = defaultdict(float)
    project_rows = Counter()
    for entry in entries:
        if entry["project_key"] in projects:
            project_hours[entry["project_key"]] += entry["hours"]
            project_rows[entry["project_key"]] += 1

    def payroll_rows_for(entry):
        rows = cost_by_key.get(entry["employee_number"], [])
        for candidate in (entry["employee_master_name"], entry["employee"]):
            if rows:
                break
            rows = cost_by_name.get(clean_key(candidate), [])
        return rows

    payroll_months = {row["month"] for rows in cost_by_key.values() for row in rows}
    # Salary accrues whether or not someone logs time in a given week, so cost
    # covers everyone in the timesheet population; that keeps weeks and months
    # summing to the same total.
    population = {}
    for entry in entries:
        population.setdefault(entry["employee"] or "Unknown", payroll_rows_for(entry))

    rows = []
    for grain, key, label, period_start, period_end in trend_periods(start, end):
        clip_start, clip_end = max(period_start, start), min(period_end, end)
        inside = [entry for entry in entries if clip_start <= entry["date"] <= clip_end]
        logged = sum(entry["hours"] for entry in inside)
        client_entries = [entry for entry in inside if entry["project_key"] in projects]
        client = sum(entry["hours"] for entry in client_entries)
        approved = sum(entry["hours"] for entry in inside if clean_text(entry["status"]).casefold() == "approved")
        active_projects = {entry["project_key"] for entry in client_entries if entry["hours"] > 0}

        prorated = effort = 0.0
        period_hours = defaultdict(float)
        period_rows = Counter()
        for entry in client_entries:
            period_hours[entry["project_key"]] += entry["hours"]
            period_rows[entry["project_key"]] += 1
        for project_id in project_hours:
            record = projects[project_id]
            p_start, p_end, revenue = record["start"], record["end"], record["contract_revenue"]
            if p_start and p_end and p_end >= p_start and p_end >= start and p_start <= end:
                overlap = (min(p_end, clip_end) - max(p_start, clip_start)).days + 1
                if overlap > 0:
                    prorated += revenue * overlap / ((p_end - p_start).days + 1)
            elif project_hours[project_id] > 0:
                effort += revenue * period_hours.get(project_id, 0.0) / project_hours[project_id]
            elif project_rows[project_id]:
                effort += revenue * period_rows.get(project_id, 0) / project_rows[project_id]

        hours_by_person = defaultdict(float)
        for entry in inside:
            hours_by_person[entry["employee"] or "Unknown"] += entry["hours"]
        cost_inr, costed_hours, costed_people = 0.0, 0.0, 0
        for person, payroll_rows in population.items():
            cost, covered, _ = payroll_cost_for_window(payroll_rows, clip_start, clip_end)
            if covered:
                cost_inr += cost
                costed_hours += hours_by_person.get(person, 0.0)
                costed_people += 1
        days_covered = sum(1 for offset in range((clip_end - clip_start).days + 1)
                           if (clip_start + timedelta(days=offset)).replace(day=1) in payroll_months)

        calendar_days = (period_end - period_start).days + 1
        data_days = (clip_end - clip_start).days + 1
        rows.append({
            "grain": grain, "period_key": key, "label": label,
            "period_start": iso(period_start), "period_end": iso(period_end),
            "calendar_days": calendar_days, "data_days": data_days,
            "partial": "yes" if data_days < calendar_days else "no",
            "timesheet_rows": len(inside),
            "logged_hours": f"{logged:.6f}",
            "client_hours": f"{client:.6f}",
            "internal_hours": f"{logged - client:.6f}",
            "approved_hours": f"{approved:.6f}",
            "projects_active": len(active_projects),
            "clients_active": len({projects[pid]["client_id"] for pid in active_projects}),
            "people_active": sum(1 for hours in hours_by_person.values() if hours > 0),
            "revenue": f"{prorated + effort:.2f}",
            "revenue_prorated": f"{prorated:.2f}",
            "revenue_effort": f"{effort:.2f}",
            "payroll_cost_inr": f"{cost_inr:.2f}",
            "payroll_cost_aed": f"{cost_inr * INR_TO_AED:.2f}",
            "payroll_days_covered": days_covered,
            "costed_hours": f"{costed_hours:.6f}",
            "costed_people": costed_people,
        })
    return TREND_FIELDS, rows


def carry_forward_payroll(payroll_by_id, through):
    """Repeat each current employee's latest payroll Total for months the payroll
    export does not reach yet, up to `through`.

    Only people with a row in the latest payroll month are carried, so leavers
    stay off the books. The raw Total is reused, so the salary-revision rule in
    payroll_month_cost still applies revisions dated after the last export.
    Returns (last payroll month, carried months, carried rows).
    """
    months = {row["month"] for rows in payroll_by_id.values() for row in rows}
    if not months or not through:
        return None, [], 0
    last = max(months)
    carried_months = []
    cursor = date(last.year + (last.month == 12), last.month % 12 + 1, 1)
    while cursor <= through:
        carried_months.append(cursor)
        cursor = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
    carried = 0
    for rows in payroll_by_id.values():
        latest = max(rows, key=lambda row: row["month"])
        if latest["month"] != last:
            continue
        for month in carried_months:
            rows.append({**latest, "month": month, "carried_from": last})
            carried += 1
    return last, carried_months, carried


def load_payroll_costs():
    payroll_rows = read_payroll_records()
    revisions = read_salary_revisions()
    revisions_by_id = defaultdict(list)
    for revision in revisions:
        if revision["employee_id"]:
            revisions_by_id[revision["employee_id"]].append(revision)
    for row in payroll_rows:
        row["salary_revisions"] = sorted(revisions_by_id.get(row["employee_id"], []),
                                          key=lambda revision: revision["effective_from"])
    payroll_by_id = defaultdict(list)
    for row in payroll_rows:
        if row["employee_id"]:
            payroll_by_id[row["employee_id"]].append(row)
    payroll_ids_by_name = defaultdict(set)
    for row in payroll_rows:
        name_key = clean_key(row["employee"])
        if name_key and row["employee_id"]:
            payroll_ids_by_name[name_key].add(row["employee_id"])
    payroll_by_name = {
        name_key: payroll_by_id[next(iter(employee_ids))]
        for name_key, employee_ids in payroll_ids_by_name.items()
        if len(employee_ids) == 1
    }
    master_ids = {clean_text(employee.get("Employee Number")) for employee in read_employees()}
    metadata = {
        "loaded": bool(payroll_rows),
        "file": PAYROLL_FILE if payroll_rows else None,
        "rows": len(payroll_rows),
        "matched": 0,
        "revision_file": SALARY_REVISIONS_FILE if revisions else None,
        "revision_rows": len(revisions),
        "unmatched_employee_ids": sorted({row["employee_id"] for row in payroll_rows
                                           if row["employee_id"] and row["employee_id"] not in master_ids}),
        "currency": "AED",
        "source_currency": "INR",
        "inr_to_aed": INR_TO_AED,
        "basis": "Monthly payroll Total, prorated by calendar days",
        "revision_rule": "Apply approved salary revisions by effective date only when payroll Total matches the previous regular monthly salary within 1%; otherwise retain payroll Total.",
        "revision_match_tolerance_pct": 1.0,
    }
    metadata["unique_name_fallbacks"] = len(payroll_by_name)
    return payroll_by_id, payroll_by_name, revisions, metadata


# --------------------------------------------------------------------------- main


def parse_cli_date(value, flag):
    date = parse_date(value, ("%Y-%m-%d",))
    if not date:
        raise SystemExit(f"{flag} must be an ISO date, e.g. 2026-07-22.")
    return date


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build the profitability EDA datasets.")
    parser.add_argument("--start", help="First timesheet date to include (YYYY-MM-DD). Defaults to the earliest logged date.")
    parser.add_argument("--end", help="Last timesheet date to include (YYYY-MM-DD). Defaults to the latest logged date.")
    args = parser.parse_args(argv)
    start = parse_cli_date(args.start, "--start") if args.start else None
    end = parse_cli_date(args.end, "--end") if args.end else None
    if start and end and start > end:
        raise SystemExit("--start must be on or before --end.")

    costs, costs_by_name, salary_revisions, cost_meta = load_payroll_costs()
    data = build((start, end) if start or end else None)
    data["cost_loaded"] = cost_meta["loaded"]
    # Payroll exports lag the timesheet; carry the latest month forward to the
    # last logged date so every period in the history has a cost.
    last_payroll, carried_months, carried_rows = carry_forward_payroll(costs, data["data_end"])
    cost_meta["last_payroll_month"] = iso(last_payroll)
    cost_meta["carried_forward_months"] = [month.strftime("%Y-%m") for month in carried_months]
    cost_meta["carried_forward_rows"] = carried_rows
    if carried_months:
        cost_meta["basis"] += f"; {last_payroll.strftime('%b %Y')} carried forward through {carried_months[-1].strftime('%b %Y')}"
    payroll_months = {row["month"] for rows in costs.values() for row in rows}
    cost_meta["covered_days"] = 0
    if data["window_start"] and data["window_end"]:
        for month in payroll_months:
            month_end = date(month.year, month.month, calendar.monthrange(month.year, month.month)[1])
            overlap_start = max(data["window_start"], month)
            overlap_end = min(data["window_end"], month_end)
            if overlap_start <= overlap_end:
                cost_meta["covered_days"] += (overlap_end - overlap_start).days + 1

    project_hours = build_project_hours(data)
    utilisation_fields, utilisation_rows = build_employee_utilisation(data, costs, costs_by_name)
    cost_meta["matched"] = sum(1 for row in utilisation_rows if int(row["covered_payroll_days"]))
    cost_meta["name_fallback_matched"] = sum(1 for row in utilisation_rows if row["cost_source"] == "employee name")
    cost_meta["unmatched_employees"] = [row["employee"] for row in utilisation_rows if not int(row["covered_payroll_days"])]
    payroll_source_rows = [row for employee_rows in costs.values() for row in employee_rows]
    payroll_cost_fields, payroll_cost_rows = build_payroll_cost_monthly(payroll_source_rows)
    cost_meta["revision_adjusted_months"] = sum(int(row["revision_adjusted_months"]) for row in utilisation_rows)
    cost_meta["revision_adjusted_source_months"] = sum(row["revision_applied"] == "yes" for row in payroll_cost_rows)

    internal_fields, internal_rows = build_internal_time(data)
    unallocated_fields, unallocated_rows = build_unallocated(data)
    no_dept_fields, no_dept_rows = build_unallocated_no_dept(data, unallocated_rows)
    no_dept_hours = sum(float(row["hours"]) for row in no_dept_rows)
    mismatch_fields, mismatch_rows = build_period_mismatch(data)
    service_fields, service_rows = build_service_mix(data)
    audit_fields, audit_rows = build_allocation_audit(data)
    client_summary_fields, client_summary_rows = build_client_summary(data, project_hours)
    people_summary_fields, people_summary_rows = build_people_summary(data, project_hours, utilisation_rows)
    trend_fields, trend_rows = build_trends(data, costs, costs_by_name)

    # ---- reconciliation counters
    logged_hours = sum(entry["hours"] for entry in data["entries"])
    client_hours = sum(row["hours"] for row in data["actual"])
    internal_hours = sum(entry["hours"] for entry in data["internal"])
    emitted_hours = sum(float(row["total_hours"]) for row in project_hours)
    unallocated_hours = sum(value["hours"] for value in data["unallocated_register"].values())

    project_keys = Counter(clean_key(row.get("name")) for row in data["project_rows"] if clean_text(row.get("name")))
    duplicate_keys = {key: count for key, count in project_keys.items() if count > 1}
    conflicting = [record for record in data["projects"].values() if record.get("client_name_conflict") == "yes"]
    recovered_revenue = sum(record["contract_revenue"] - record["first_row_revenue"] for record in data["projects"].values() if record["source_rows"] > 1)
    recovered_touched = sum(data["projects"][pid]["contract_revenue"] - data["projects"][pid]["first_row_revenue"]
                            for pid in data["records"] if pid != UNALLOCATED_ID and data["projects"][pid]["source_rows"] > 1)
    touched = {project_id for project_id in data["records"] if project_id != UNALLOCATED_ID}
    zero_revenue = [pid for pid in touched if data["projects"][pid]["contract_revenue"] <= 0]
    deleted_revenue = sum(data["projects"][pid]["in_window_revenue"] for pid in touched if data["projects"][pid]["status"] == "deleted")
    future_revenue = sum(data["projects"][pid]["in_window_revenue"] for pid in touched if data["projects"][pid]["status"] in {"future", "next_month"})
    not_in_master = sorted({entry["employee"] for entry in data["entries"] if not entry["in_master"] and entry["employee"]})
    name_matched_rows = sum(1 for entry in data["entries"] if entry["tl_source"] == "Name match")
    name_matched_hours = sum(entry["hours"] for entry in data["entries"] if entry["tl_source"] == "Name match")
    no_match_rows = sum(1 for entry in data["entries"] if entry["tl_source"] == "No match")
    no_match_hours = sum(entry["hours"] for entry in data["entries"] if entry["tl_source"] == "No match")
    contract_revenue = sum(data["projects"][pid]["contract_revenue"] for pid in touched)
    in_window_revenue = sum(data["projects"][pid]["in_window_revenue"] for pid in touched)
    basis_mix = Counter(data["projects"][pid]["revenue_basis"] for pid in touched)
    method_hours = defaultdict(float)
    for row in project_hours:
        method_hours[row["allocation_method"]] += float(row["total_hours"])

    quality = [
        ("Unallocated internal hours", "Allocation", "high", len(unallocated_rows), unallocated_hours,
         "Internal time with no usable project or TL portfolio; parked in the Unallocated bucket"),
        ("Duplicate project rows merged", "Revenue", "medium", sum(count - 1 for count in duplicate_keys.values()), recovered_revenue,
         f"{len(duplicate_keys)} project names appeared on multiple rows; summing rather than first-wins recovers {recovered_touched:,.2f} on projects with logged hours"),
        ("Project names spanning multiple clients", "Revenue", "medium", len(conflicting), 0.0,
         "Same project name mapped to more than one client_legal_name"),
        ("Projects with zero contract revenue", "Revenue", "medium", len(zero_revenue), 0.0,
         "Hours logged against projects whose amount is 0"),
        ("Revenue on deleted projects", "Revenue", "high", sum(1 for pid in touched if data["projects"][pid]["status"] == "deleted"), deleted_revenue,
         "In-window revenue attached to projects flagged deleted"),
        ("Revenue on future projects", "Revenue", "medium", sum(1 for pid in touched if data["projects"][pid]["status"] in {"future", "next_month"}), future_revenue,
         "In-window revenue attached to projects not yet started"),
        ("Timesheet people missing from employee master", "People", "high", len(not_in_master), 0.0,
         ", ".join(not_in_master) or "none"),
        ("Reporting line matched by name, not email", "People", "low", name_matched_rows, name_matched_hours,
         "Timesheet email missing from the master, so the reporting line came from a name match"),
        ("Timesheet rows with no reporting line", "People", "medium", no_match_rows, no_match_hours,
         "No reporting line could be resolved by email or by name"),
        ("Projects with revenue period mismatch", "Revenue", "high", len(mismatch_rows), sum(float(row["contract_revenue"]) for row in mismatch_rows),
         "Hours logged in window but the contract window does not overlap, or has no dates"),
    ]
    quality_fields, quality_rows = build_data_quality(data, quality)

    counts = {
        OUT_PROJECT_HOURS: write_csv(OUT_PROJECT_HOURS, PROJECT_HOURS_FIELDS, project_hours),
        OUT_EMPLOYEE_UTILISATION: write_csv(OUT_EMPLOYEE_UTILISATION, utilisation_fields, utilisation_rows),
        OUT_INTERNAL_TIME: write_csv(OUT_INTERNAL_TIME, internal_fields, internal_rows),
        OUT_UNALLOCATED: write_csv(OUT_UNALLOCATED, unallocated_fields, unallocated_rows),
        OUT_UNALLOCATED_NO_DEPT: write_csv(OUT_UNALLOCATED_NO_DEPT, no_dept_fields, no_dept_rows),
        OUT_PERIOD_MISMATCH: write_csv(OUT_PERIOD_MISMATCH, mismatch_fields, mismatch_rows),
        OUT_DATA_QUALITY: write_csv(OUT_DATA_QUALITY, quality_fields, quality_rows),
        OUT_SERVICE_MIX: write_csv(OUT_SERVICE_MIX, service_fields, service_rows),
        OUT_ALLOCATION_AUDIT: write_csv(OUT_ALLOCATION_AUDIT, audit_fields, audit_rows),
        OUT_CLIENT_SUMMARY: write_csv(OUT_CLIENT_SUMMARY, client_summary_fields, client_summary_rows),
        OUT_PEOPLE_SUMMARY: write_csv(OUT_PEOPLE_SUMMARY, people_summary_fields, people_summary_rows),
        OUT_TRENDS: write_csv(OUT_TRENDS, trend_fields, trend_rows),
    }
    counts[OUT_EMPLOYEE_COST] = write_csv(OUT_EMPLOYEE_COST, utilisation_fields, utilisation_rows)
    revision_fields = ["employee_number", "employee", "effective_from", "previous_regular_salary_inr", "revised_regular_salary_inr"]
    revision_rows = [{
        "employee_number": row["employee_id"],
        "employee": row["employee"],
        "effective_from": iso(row["effective_from"]),
        "previous_regular_salary_inr": f"{row['previous_regular_salary_inr']:.2f}",
        "revised_regular_salary_inr": f"{row['revised_regular_salary_inr']:.2f}",
    } for row in salary_revisions]
    counts[OUT_SALARY_REVISIONS] = write_csv(OUT_SALARY_REVISIONS, revision_fields, revision_rows)
    counts[OUT_PAYROLL_COST_MONTHLY] = write_csv(OUT_PAYROLL_COST_MONTHLY, payroll_cost_fields, payroll_cost_rows)

    manifest = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "window": {"start": iso(data["window_start"]), "end": iso(data["window_end"]), "days": data["window_days"],
                   "months": round(data["window_days"] / 30.44, 3) if data["window_days"] else 0,
                   "custom": data["window_custom"],
                   "data_start": iso(data["data_start"]), "data_end": iso(data["data_end"])},
        "sources": {"projects": PROJECTS_FILE, "timesheet": TIMESHEET_FILE, "employees": EMPLOYEES_FILE,
                "payroll": cost_meta["file"], "salary_revisions": cost_meta["revision_file"]},
        "cost": {**cost_meta,
                 "unmatched_employees": cost_meta["unmatched_employees"][:50]},
        "totals": {
            "timesheet_rows": len(data["entries"]),
            "logged_hours": round(logged_hours, 6),
            "client_hours": round(client_hours, 6),
            "internal_hours": round(internal_hours, 6),
            "allocated_hours": round(internal_hours - unallocated_hours, 6),
            "unallocated_hours": round(unallocated_hours, 6),
            "emitted_hours": round(emitted_hours, 6),
            "reconciliation_drift": round(logged_hours - emitted_hours, 6),
            "projects_touched": len(touched),
            "clients_touched": len({data["projects"][pid]["client_id"] for pid in touched}),
            "employees": len(utilisation_rows),
            "clients_summarised": sum(1 for row in client_summary_rows if row["client_id"] != UNALLOCATED_ID),
            "people_summarised": len(people_summary_rows),
            "contract_revenue": round(contract_revenue, 2),
            "in_window_revenue": round(in_window_revenue, 2),
            "eda_rows": counts[OUT_PROJECT_HOURS],
        },
        "revenue_basis_mix": dict(basis_mix),
        "allocation_method_hours": {key: round(value, 4) for key, value in sorted(method_hours.items())},
        "datasets": [
            {"key": "project_hours", "label": "Project contributor rows", "file": OUT_PROJECT_HOURS, "rows": counts[OUT_PROJECT_HOURS]},
            {"key": "employee_utilisation", "label": "Employee utilisation", "file": OUT_EMPLOYEE_UTILISATION, "rows": counts[OUT_EMPLOYEE_UTILISATION]},
            {"key": "internal_time", "label": "Internal time composition", "file": OUT_INTERNAL_TIME, "rows": counts[OUT_INTERNAL_TIME]},
            {"key": "unallocated", "label": "Unallocated hours register", "file": OUT_UNALLOCATED, "rows": counts[OUT_UNALLOCATED]},
            {"key": "unallocated_no_dept", "label": "Unallocated hours register (department pool off)", "file": OUT_UNALLOCATED_NO_DEPT, "rows": counts[OUT_UNALLOCATED_NO_DEPT]},
            {"key": "period_mismatch", "label": "Revenue period mismatch", "file": OUT_PERIOD_MISMATCH, "rows": counts[OUT_PERIOD_MISMATCH]},
            {"key": "data_quality", "label": "Data quality checks", "file": OUT_DATA_QUALITY, "rows": counts[OUT_DATA_QUALITY]},
            {"key": "service_mix", "label": "Service mix", "file": OUT_SERVICE_MIX, "rows": counts[OUT_SERVICE_MIX]},
            {"key": "allocation_audit", "label": "Allocation audit trail", "file": OUT_ALLOCATION_AUDIT, "rows": counts[OUT_ALLOCATION_AUDIT]},
            {"key": "employee_cost", "label": "Employee cost", "file": OUT_EMPLOYEE_COST, "rows": counts[OUT_EMPLOYEE_COST]},
            {"key": "salary_revisions", "label": "Salary revisions", "file": OUT_SALARY_REVISIONS, "rows": counts[OUT_SALARY_REVISIONS]},
            {"key": "payroll_cost_monthly", "label": "Monthly payroll cost audit", "file": OUT_PAYROLL_COST_MONTHLY, "rows": counts[OUT_PAYROLL_COST_MONTHLY]},
            {"key": "client_summary", "label": "Client summary", "file": OUT_CLIENT_SUMMARY, "rows": counts[OUT_CLIENT_SUMMARY]},
            {"key": "people_summary", "label": "People summary", "file": OUT_PEOPLE_SUMMARY, "rows": counts[OUT_PEOPLE_SUMMARY]},
            {"key": "trends", "label": "Monthly and weekly trends", "file": OUT_TRENDS, "rows": counts[OUT_TRENDS]},
        ],
        "trends": {
            "basis": "Full timesheet history regardless of the selected window",
            "start": iso(data["data_start"]), "end": iso(data["data_end"]),
            "week_start": "Monday",
            "revenue_rule": "Dated contracts prorated by calendar days in each period; undated or out-of-history contracts spread by hours share.",
        },
        "quality": [{"check": row["check"], "category": row["category"], "severity": row["severity"],
                     "count": row["count"], "value": row["value"], "detail": row["detail"]} for row in quality_rows],
        "unallocated_variants": {
            "with_department": {"file": OUT_UNALLOCATED, "count": len(unallocated_rows),
                                "hours": round(unallocated_hours, 6)},
            "without_department": {"file": OUT_UNALLOCATED_NO_DEPT, "count": len(no_dept_rows),
                                   "hours": round(no_dept_hours, 6),
                                   "detail": "Base unallocated register plus employees whose internal was previously spread by the department pool."},
        },
    }
    (ROOT / OUT_MANIFEST).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"Window {manifest['window']['start']} to {manifest['window']['end']} ({data['window_days']} days)")
    print(f"Logged {logged_hours:,.2f}h = client {client_hours:,.2f}h + internal {internal_hours:,.2f}h")
    print(f"Emitted {emitted_hours:,.2f}h (drift {logged_hours - emitted_hours:+.6f}h), unallocated {unallocated_hours:,.2f}h")
    print(f"Revenue contract {contract_revenue:,.2f} -> in-window {in_window_revenue:,.2f}")
    for name, count in counts.items():
        print(f"  {name}: {count:,} rows")
    print(f"  {OUT_MANIFEST}: manifest written")
    if not cost_meta["loaded"]:
        print("Payroll file not present. Upload the monthly payroll workbook to unlock cost and margin.")


if __name__ == "__main__":
    main()

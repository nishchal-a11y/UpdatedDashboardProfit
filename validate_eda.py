"""Re-check the EDA outputs after a build.

Every assertion here is an accounting identity the dashboard relies on: hours
must reconcile from the timesheet through to the emitted rows, revenue must be
carried exactly once per project, and the allocation weights must add to 100%
for each person. Run it straight after build_eda.py.
"""

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).parent
# Hours and revenue are written with six and two decimals, so comparisons of
# sums carry that rounding error times the number of rows.
HOUR_TOL = 0.01
ROW_TOL = 2e-6
MONEY_TOL = 1.0

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" :: {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def read(name):
    path = ROOT / name
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def value(row, key):
    return float(row.get(key) or 0)


def main():
    manifest_path = ROOT / "EDA_Manifest.json"
    if not manifest_path.exists():
        print("EDA_Manifest.json is missing. Run python3 build_eda.py first.")
        return 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    totals = manifest["totals"]

    project_hours = read("EDA_Project_Hours.csv")
    utilisation = read("EDA_Employee_Utilization.csv")
    audit = read("EDA_Allocation_Audit.csv")
    unallocated = read("EDA_Unallocated_Hours.csv")
    internal = read("EDA_Internal_Time.csv")
    mismatch = read("EDA_Period_Mismatch.csv")
    client_summary = read("EDA_Client_Summary.csv")
    people_summary = read("EDA_People_Summary.csv")

    # ---- hours reconcile
    bad = [row for row in project_hours
           if abs(value(row, "project_hours") + value(row, "allocated_hours") + value(row, "unallocated_hours") - value(row, "total_hours")) > ROW_TOL]
    check("row total = actual + allocated + unallocated", not bad, f"{len(bad)} rows")

    bad = [row for row in project_hours
           if abs(value(row, "approved_hours") + value(row, "nonapproved_hours") - value(row, "total_hours")) > ROW_TOL]
    check("row total = approved + non-approved", not bad, f"{len(bad)} rows")

    emitted = sum(value(row, "total_hours") for row in project_hours)
    check("emitted hours = logged hours", abs(emitted - totals["logged_hours"]) < HOUR_TOL,
          f"{emitted:,.4f} vs {totals['logged_hours']:,.4f}")
    check("client + internal = logged", abs(totals["client_hours"] + totals["internal_hours"] - totals["logged_hours"]) < HOUR_TOL)
    check("allocated + unallocated = internal", abs(totals["allocated_hours"] + totals["unallocated_hours"] - totals["internal_hours"]) < HOUR_TOL)
    method_hours = sum(manifest["allocation_method_hours"].values())
    check("allocation methods sum to logged hours", abs(method_hours - totals["logged_hours"]) < HOUR_TOL, f"{method_hours:,.4f}")

    # ---- revenue is carried once per project
    revenue_rows = defaultdict(int)
    for row in project_hours:
        if value(row, "in_window_revenue"):
            revenue_rows[row["project_id"]] += 1
    check("revenue carried on one row per project", all(count == 1 for count in revenue_rows.values()),
          f"{sum(1 for count in revenue_rows.values() if count > 1)} projects with more than one")

    revenue = sum(value(row, "in_window_revenue") for row in project_hours)
    check("in-window revenue = manifest", abs(revenue - totals["in_window_revenue"]) < MONEY_TOL, f"{revenue:,.2f}")

    projects = {row["project_id"]: (value(row, "contract_revenue"), value(row, "in_window_revenue"))
                for row in project_hours if value(row, "contract_revenue") or value(row, "in_window_revenue")}
    bad = [pid for pid, (contract, in_window) in projects.items() if in_window > contract + 0.01]
    check("in-window revenue never exceeds contract", not bad, f"{len(bad)} projects")
    bucket = [row for row in project_hours if row["project_id"] == "__unallocated__"]
    check("unallocated bucket carries no revenue", all(value(row, "in_window_revenue") == 0 for row in bucket), f"{len(bucket)} rows")

    # ---- allocation
    allocated = sum(value(row, "allocated_hours") for row in audit)
    check("audit allocated hours = manifest allocated", abs(allocated - totals["allocated_hours"]) < HOUR_TOL, f"{allocated:,.4f}")
    weights = defaultdict(float)
    for row in audit:
        weights[(row["employee"], row["allocation_method"])] += value(row, "weight_pct")
    bad = {key: total for key, total in weights.items() if abs(total - 100) > 0.05}
    check("donor weights sum to 100% per person and method", not bad, f"{len(bad)} groups")

    register = sum(value(row, "hours") for row in unallocated)
    check("unallocated register = manifest unallocated", abs(register - totals["unallocated_hours"]) < HOUR_TOL, f"{register:,.4f}")
    emitted_unallocated = sum(value(row, "unallocated_hours") for row in project_hours)
    check("unallocated column = register", abs(emitted_unallocated - register) < HOUR_TOL, f"{emitted_unallocated:,.4f}")
    check("internal time file = manifest internal", abs(sum(value(row, "hours") for row in internal) - totals["internal_hours"]) < HOUR_TOL)

    # ---- people
    check("utilisation client hours = manifest", abs(sum(value(row, "client_hours") for row in utilisation) - totals["client_hours"]) < HOUR_TOL)
    check("utilisation internal hours = manifest", abs(sum(value(row, "internal_hours") for row in utilisation) - totals["internal_hours"]) < HOUR_TOL)
    bad = [row for row in utilisation
           if abs(value(row, "client_hours") + value(row, "internal_hours") - value(row, "total_logged_hours")) > ROW_TOL]
    check("person total = client + internal", not bad, f"{len(bad)} rows")
    bad = [row for row in utilisation
           if abs(value(row, "allocated_out_hours") + value(row, "unallocated_hours") - value(row, "internal_hours")) > HOUR_TOL]
    check("allocated out + unallocated = internal per person", not bad, f"{len(bad)} rows")

    # ---- payroll cost and salary revisions
    cost_rows = read("EDA_Employee_Cost.csv")
    revision_rows = read("EDA_Salary_Revisions.csv")
    monthly_cost_rows = read("EDA_Payroll_Cost_Monthly.csv")
    if manifest["cost"]["loaded"]:
        rate = manifest["cost"]["inr_to_aed"]
        covered_days = manifest["cost"]["covered_days"]
        check("payroll coverage days stay within selected window", 0 <= covered_days <= manifest["window"]["days"],
              f"{covered_days} / {manifest['window']['days']} days")
        bad = []
        for row in cost_rows:
            if not row["covered_payroll_days"]:
                continue
            cost_inr = value(row, "window_cost_inr")
            cost_aed = value(row, "window_cost_aed")
            logged = value(row, "total_logged_hours")
            if abs(cost_aed - cost_inr * rate) > 0.02:
                bad.append(row["employee"])
            elif logged and abs(value(row, "cost_per_hour_absorption") - cost_aed / logged) > 1e-4:
                bad.append(row["employee"])
        check("payroll INR to AED and hourly cost arithmetic", not bad, f"{len(bad)} people")
        check("salary revision audit row count", len(revision_rows) == manifest["cost"]["revision_rows"],
              f"{len(revision_rows)} rows")
    else:
        print("SKIP cost checks :: no payroll file loaded")

    # ---- client summary
    for label, rows in (("client summary", client_summary), ("people summary", people_summary)):
        bad = [row for row in rows
               if abs(value(row, "actual_hours") + value(row, "allocated_hours") + value(row, "unallocated_hours") - value(row, "total_hours")) > ROW_TOL]
        check(f"{label} row total = actual + allocated + unallocated", not bad, f"{len(bad)} rows")

    client_hours = sum(value(row, "total_hours") for row in client_summary)
    check("client summary hours = emitted hours", abs(client_hours - totals["emitted_hours"]) < HOUR_TOL, f"{client_hours:,.4f}")
    client_revenue = sum(value(row, "in_window_revenue") for row in client_summary)
    check("client summary revenue = manifest", abs(client_revenue - totals["in_window_revenue"]) < MONEY_TOL, f"{client_revenue:,.2f}")
    real_clients = [row for row in client_summary if row["client_id"] != "__unallocated__"]
    check("client summary count = clients touched", len(real_clients) == totals["clients_touched"],
          f"{len(real_clients)} vs {totals['clients_touched']}")
    bad = [row for row in client_summary if row["client_id"] == "__unallocated__" and value(row, "in_window_revenue")]
    check("client summary overhead row carries no revenue", not bad)

    # ---- people summary
    people_hours = sum(value(row, "total_hours") for row in people_summary)
    check("people summary hours = logged hours", abs(people_hours - totals["logged_hours"]) < HOUR_TOL, f"{people_hours:,.4f}")
    check("people summary count = employees", len(people_summary) == totals["employees"],
          f"{len(people_summary)} vs {totals['employees']}")
    people_revenue = sum(value(row, "revenue_share") for row in people_summary)
    check("people summary revenue = manifest", abs(people_revenue - totals["in_window_revenue"]) < MONEY_TOL, f"{people_revenue:,.2f}")
    logged_by_person = {row["employee"]: value(row, "total_logged_hours") for row in utilisation}
    bad = [row["employee"] for row in people_summary
           if abs(value(row, "total_hours") - logged_by_person.get(row["employee"], -1)) > HOUR_TOL]
    check("people summary hours = utilisation hours per person", not bad, f"{len(bad)} people")

    # ---- registers
    check("period mismatch excludes prorated projects", not [row for row in mismatch if row["revenue_basis"] == "Prorated"])
    check("manifest row count matches the emitted file", totals["eda_rows"] == len(project_hours))

    # ---- trends (full history; only comparable to the manifest when no window is applied)
    trends = read("EDA_Trends.csv")
    months = [row for row in trends if row["grain"] == "month"]
    weeks = [row for row in trends if row["grain"] == "week"]
    for metric, tol in (("logged_hours", HOUR_TOL), ("revenue", MONEY_TOL), ("payroll_cost_inr", MONEY_TOL)):
        month_sum = sum(value(row, metric) for row in months)
        week_sum = sum(value(row, metric) for row in weeks)
        check(f"trend weeks = trend months :: {metric}", abs(month_sum - week_sum) < tol, f"{month_sum:,.2f}")
    if not manifest["window"]["custom"]:
        month_hours = sum(value(row, "logged_hours") for row in months)
        month_revenue = sum(value(row, "revenue") for row in months)
        check("trend months hours = manifest logged hours", abs(month_hours - totals["logged_hours"]) < HOUR_TOL, f"{month_hours:,.4f}")
        check("trend months revenue = manifest revenue", abs(month_revenue - totals["in_window_revenue"]) < MONEY_TOL, f"{month_revenue:,.2f}")

    print()
    print("FAILED:", ", ".join(failures) if failures else "none")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

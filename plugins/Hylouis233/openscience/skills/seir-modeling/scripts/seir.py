#!/usr/bin/env python3
"""Integrate SIR/SEIR compartment models with a hand-written RK4 solver.

Pure stdlib. Prints the daily time series of S/E/I/R plus the peak
infectious day and count, as JSON or CSV. These are deterministic
scenario projections, not forecasts; always report parameters with them.
"""

import argparse
import csv
import json
import sys


def rhs_sir(state, beta, sigma, gamma, population):
    """SIR right-hand side; sigma is unused and accepted for uniformity."""
    s, e, i, r = state
    infection = beta * s * i / population
    return (-infection, 0.0, infection - gamma * i, gamma * i)


def rhs_seir(state, beta, sigma, gamma, population):
    """SEIR right-hand side: S -> E (rate beta*S*I/N) -> I (sigma) -> R."""
    s, e, i, r = state
    infection = beta * s * i / population
    return (-infection, infection - sigma * e, sigma * e - gamma * i, gamma * i)


def rk4_step(rhs, state, dt, params):
    """Advance one classical Runge-Kutta 4th-order step."""
    k1 = rhs(state, *params)
    k2 = rhs([x + 0.5 * dt * k for x, k in zip(state, k1)], *params)
    k3 = rhs([x + 0.5 * dt * k for x, k in zip(state, k2)], *params)
    k4 = rhs([x + dt * k for x, k in zip(state, k3)], *params)
    return [x + dt * (a + 2.0 * b + 2.0 * c + d) / 6.0
            for x, a, b, c, d in zip(state, k1, k2, k3, k4)]


def validate(args):
    """Reject non-positive parameters and inconsistent initial counts."""
    problems = []
    for name in ("beta", "gamma", "population", "i0"):
        if getattr(args, name) <= 0:
            problems.append("%s must be > 0" % name)
    if args.model == "seir" and args.sigma is None:
        problems.append("--sigma is required for --model seir")
    if args.sigma is not None and args.sigma <= 0:
        problems.append("sigma must be > 0")
    if args.e0 < 0:
        problems.append("e0 must be >= 0")
    if args.i0 + args.e0 > args.population:
        problems.append("i0 + e0 exceeds population")
    if args.days < 1:
        problems.append("days must be >= 1")
    if args.dt <= 0 or args.dt > 1.0:
        problems.append("dt must be in (0, 1]")
    if problems:
        sys.exit("error: invalid input: " + "; ".join(problems))


def integrate(args):
    """Run the model; return (series, peak) with daily snapshots."""
    rhs = rhs_seir if args.model == "seir" else rhs_sir
    sigma = args.sigma if args.sigma is not None else 0.0
    params = (args.beta, sigma, args.gamma, float(args.population))
    # Initial state: everyone not exposed/infectious starts susceptible.
    state = [float(args.population - args.i0 - args.e0),
             float(args.e0), float(args.i0), 0.0]
    series = []
    peak_day, peak_i = 0, state[2]
    steps_per_day = max(1, round(1.0 / args.dt))
    total_steps = int(round(args.days * steps_per_day))
    for step in range(total_steps + 1):
        if step % steps_per_day == 0:
            day = step // steps_per_day
            s, e, i, r = (max(0.0, x) for x in state)  # clip RK4 undershoot
            series.append({"day": day, "S": round(s, 2), "E": round(e, 2),
                           "I": round(i, 2), "R": round(r, 2)})
            if i > peak_i:
                peak_day, peak_i = day, i
        if step < total_steps:
            state = rk4_step(rhs, state, args.dt, params)
    return series, {"day": peak_day, "infectious": round(peak_i, 2)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--model", choices=["sir", "seir"], required=True)
    ap.add_argument("--beta", type=float, required=True,
                    help="transmission rate (contacts/day x Pr(infection))")
    ap.add_argument("--sigma", type=float,
                    help="incubation rate 1/latent-period (SEIR only)")
    ap.add_argument("--gamma", type=float, required=True,
                    help="recovery rate 1/infectious-period")
    ap.add_argument("--population", type=int, required=True)
    ap.add_argument("--i0", type=int, required=True, help="initial infectious")
    ap.add_argument("--e0", type=int, default=0, help="initial exposed (SEIR)")
    ap.add_argument("--days", type=int, required=True, help="horizon in days")
    ap.add_argument("--dt", type=float, default=0.1,
                    help="RK4 integration step in days (default 0.1)")
    ap.add_argument("--format", choices=["json", "csv"], default="json")
    args = ap.parse_args()
    validate(args)

    series, peak = integrate(args)
    result = {
        "model": args.model,
        "parameters": {"beta": args.beta, "sigma": args.sigma,
                       "gamma": args.gamma, "population": args.population,
                       "e0": args.e0, "i0": args.i0, "days": args.days,
                       "dt": args.dt},
        # R0 = beta/gamma holds for SIR and, in this formulation, for SEIR.
        "r0": round(args.beta / args.gamma, 4),
        "peak": peak,
        "series": series,
    }
    if args.format == "json":
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return

    writer = csv.writer(sys.stdout)
    writer.writerow(["day", "S", "E", "I", "R"])
    for row in series:
        writer.writerow([row["day"], row["S"], row["E"], row["I"], row["R"]])
    # Peak summary goes to stderr so stdout stays a clean CSV stream.
    print("# peak: day %d, infectious %.0f, R0 %.4f"
          % (peak["day"], peak["infectious"], result["r0"]), file=sys.stderr)


if __name__ == "__main__":
    main()

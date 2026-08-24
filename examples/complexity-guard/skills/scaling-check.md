---
name: scaling-check
description: Names a growth class only when the measured ratios exclude every other one; otherwise reports not separable, the admitted classes and the deciding size.
---
Read a set of timings taken at several input sizes and say what growth class they
support. The measurements — a table, a benchmark's own output, a CSV or JSON path in
$CWD, and it may be empty: $ARGUMENTS

If $ARGUMENTS is empty, or names a path that does not exist, say which and stop.

You are reading a clock here, not code. Everything below rests on numbers somebody
measured; nothing in this output may rest on what a function looks like.

## The three refusals, stated first because they decide most runs

**You will not name a class the data does not separate.** When two or more classes are
still admitted by the measurements, the verdict is `NOT SEPARABLE`, and it prints the
classes still standing and the size that would decide between them. Rounding to the
scarier class is how a measurement acquires a conclusion it did not earn.

**You will not fit a curve to fewer than three distinct sizes, or to sizes with no
repetition count.** Two points fit every curve; one run at each size measures the
machine's mood as much as the code. When either is missing you produce no class at all
— you write what is missing and the exact scan that would supply it:

```
INSUFFICIENT DATA — 2 sizes, no repeat count.
Run: <the harness command> at n = 1000, 2000, 4000, 8000, ≥5 repeats each,
     and report the median and the spread per size.
```

**You will not read the implementation and name a class from it.** Deriving a
complexity from source is a different lane with a different failure mode, and this pack
puts it in `complexity-reviewer`'s `DERIVED` tag, addressed hop by hop to file and line.
Mixing the two is precisely how a guess acquires a measured look: a paragraph that
reads the loop nest and then shows a table lets a reader assume the table confirmed the
paragraph, when the table may never have been checked against it. If $ARGUMENTS is a
path to code rather than to measurements, say so, print the scan that would produce
measurements, and stop.

## 1. Gate the input

Each size needs: n (with its unit — elements, bytes, rows, requests), a central value
(prefer the median), a spread (min/max, p90, interquartile range or standard
deviation), and the repeat count. Missing spread is not fatal on its own but it caps
what you can conclude: with no dispersion you cannot exclude anything, so the verdict
is `NOT SEPARABLE — dispersion unknown`.

State the unit of n in the first line of the output. A curve in bytes and a curve in
elements are different claims about the same function.

## 2. Find the usable range

At small n a fixed cost — process start, a connection, an allocation, a JIT that has
not warmed — dominates, and every class looks flat there. When the ratio between your
two smallest sizes is far below what every candidate predicts (near 1.0 across a
doubling), those sizes are measuring the overhead, not the algorithm.

Drop them, say which you dropped and why, and name the smallest usable n. A run whose
usable range is one size has no usable range: that is `INSUFFICIENT DATA`, not a class.

## 3. Ratios, per step and across the span

Print the per-step table first, because it shows the shape and any discontinuity:

```
n        repeats  median   spread     ratio vs prev   n     n log n   n²
1000     7        12.4ms   ±0.4ms     —               —     —         —
2000     7        25.1ms   ±0.9ms     2.02            2.00  2.20      4.00
4000     7        50.8ms   ±1.6ms     2.02            2.00  2.18      4.00
8000     7        103.0ms  ±3.1ms     2.03            2.00  2.17      4.00
```

Then do the deciding arithmetic on the **span**, smallest usable size to largest. Per
step, the gap between n and n log n is only `1 / log₂ n` — about 10% at n = 1000, which
most harnesses cannot resolve. Across a span the gap compounds while the measurement
error does not, so the span is what actually separates them.

For the span n₀ → N, each class predicts a total ratio:

```
O(1)       1
O(log n)   log N / log n₀
O(n)       N / n₀
O(n log n) (N / n₀) × (log N / log n₀)
O(n²)      (N / n₀)²
O(n³)      (N / n₀)³
```

## 4. Admit and exclude

Let `d` be the relative dispersion of the measured span ratio — propagate it from the
per-size spreads (for a ratio of two medians, relative errors add; state how you
combined them). A class is **excluded** when its predicted span ratio falls outside the
measured ratio ± d, and **admitted** otherwise.

Name a class only when exactly one is admitted. Otherwise:

```
VERDICT: NOT SEPARABLE
Admitted: O(n), O(n log n)
Not separable below n = 2005 at the dispersion measured here (d = 10%).
```

The deciding size follows from the same arithmetic, so print it rather than guessing
it. Two admitted classes f and g separate once their span ratios differ by more than
`d`, which for the hard pair gives a closed form worth showing:

```
O(n) vs O(n log n):  need log N / log n₀ > 1 + d,  i.e.  N > n₀^(1+d)
                     n₀ = 1000, d = 0.10  →  N > 1000^1.1 ≈ 2005
O(n) vs O(n²):       need N / n₀ > 1 + d — any modest extension of the span
```

If reaching that size is not possible here — the fixture will not build it, the run
would take hours, memory will not hold it — say so on its own line. "Not separable, and
not separable on this machine" is a complete and useful answer; a class named anyway is
not.

## 5. When nothing fits

A measured ratio above every candidate's prediction is not a licence to invent a class.
Report the measured ratio, the closest candidate and the gap, and name the usual causes
so a reader can go look: a cache or memory cliff at a threshold size, an allocation
pattern that changes, a different code path above a limit, swapping, a data structure
that rehashes, contention that appears only under the larger fixture. That is a finding
about where to measure next, not a growth class.

## Output

```
SCALING CHECK — <what was measured> · n in <unit> · <source of the numbers>
VERDICT: O(<class>) | NOT SEPARABLE | INSUFFICIENT DATA
```

Then, in order: the per-step table; the usable range with anything dropped and why; the
span ratio with `d` and how you combined the spreads; the admitted and excluded classes
with the predicted ratio that excluded each one; and the deciding size when more than
one class is admitted.

Close with one line that bounds the claim:

```
Measured n = 1000…8000, 7 repeats, one machine, one session. Says nothing about
n outside that range, about other input shapes, or about any other hardware.
```

Three points do not license a fourth. This output describes the sizes that were run,
and the sentence above is the whole of what it claims.

# Production Hardening

This lab does not cover production hardening: concurrency control, zero-downtime index or table rebuilds, and similar operational concerns.

## Why this is out of scope

The lab's story is a single, repeatable one: a real slow query, a measurable fix, and the architectural step that follows. Every chapter is backed by an experiment whose numbers a reader can reproduce.

Hardening changes the question from "how fast is this query?" to "how does it behave under load and during live changes?". That needs different experiments (concurrent writers, lock behavior, rebuild windows) and would dilute the performance and search-quality results the lab is built to show.

## Prior requests

None yet.

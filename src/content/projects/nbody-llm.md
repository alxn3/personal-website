---
title: N-Body Simulation
description: A Rust-based N-body gravitational simulator comparing a hand-written Barnes-Hut implementation against one generated almost entirely by an LLM.
summary: Simulating gravitational N-body systems in Rust, pitting a manually written Barnes-Hut algorithm against a version built almost entirely by an LLM.
url: https://alxn.dev/nbody-llm
repo: https://github.com/alxn3/nbody-llm
tags:
  - Rust
  - Barnes-Hut
  - LLM
  - WebAssembly
icon: lucide:orbit
date: 2025-05-08
---

This project simulates N-body gravitational systems in Rust, supporting both brute-force and Barnes-Hut algorithms with tunable parameters. It ships with a desktop visualizer by default and a web build (via Trunk) for running in the browser.

The interesting part: there are two separate implementations of the Barnes-Hut algorithm in the codebase — one written by hand, and one generated almost entirely by an LLM with minimal human intervention. The project exists to compare the two side by side.

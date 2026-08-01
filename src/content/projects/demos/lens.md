---
title: Lens Playground
description: An orbitable, faithfully-modeled Sigma 18-50mm F2.8 lens running live in the browser, with working zoom, focus, aperture, and an exploded view.
summary: A real camera lens, measured and rebuilt in Blender, then rigged in Three.js — drag to orbit and drive its actual mechanisms.
url: /lens
repo: https://github.com/alxn3/personal-website
tags:
  - Three.js
  - Blender
  - WebGL
  - 3D
icon: lucide:aperture
date: 2026-07-10
---

I own a Sigma 18-50mm F2.8 DC DN and wanted to see how faithfully I could rebuild it as an interactive web model. The exterior and optics were measured from the physical lens and modeled procedurally in Blender to spec, then exported to a GLB and rigged in Three.js.

The playground lets you orbit the lens and drive its real mechanisms: the 18–50mm zoom telescopes the front group, the focus ring moves the focus element, the seven-blade aperture stops down from f/2.8 to f/22, and an exploded view separates all thirteen elements along the optical axis. Removable accessories — the petal hood, UV filter, and caps — can be toggled on.

The kinematics follow an animation contract derived from how the real lens physically works, so the on-screen motion mirrors the actual optical assembly rather than an approximation.

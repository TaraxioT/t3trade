// Orbit camera controller for the biome universe.
// Owns: drag orbit, wheel + pinch zoom, idle auto-orbit, interruptible focus
// tweens, and a reduced-motion mode that keeps transitions functional but
// short and drops automatic motion entirely.

import { clamp, lerp, damp, easeInOutCubic, angleDelta } from "./util.js";

export function createCameraController(
  camera,
  dom,
  { initial, limits, onUserInput, onTap, reducedMotion = false } = {},
) {
  const lim = {
    minDistance: 26,
    maxDistance: 150,
    minPolar: 0.22,
    maxPolar: 1.32,
    ...limits,
  };

  const start = {
    azimuth: initial?.azimuth ?? 0.7,
    polar: initial?.polar ?? 0.98,
    distance: initial?.distance ?? 74,
    target: initial?.target ?? [0, 2, 0],
  };

  //Desired values follow raw input; current values ease toward them.
  const desired = { azimuth: start.azimuth, polar: start.polar, distance: start.distance };
  const current = { ...desired };
  let target = { x: start.target[0], y: start.target[1], z: start.target[2] };
  let targetGoal = { ...target };

  let tween = null;
  let idleSeconds = 0;
  let autoOrbitSpeed = 0;
  const IDLE_DELAY = 7;
  const AUTO_SPEED = 0.045;

  const pointers = new Map();
  let pinchDistance = 0;
  let downInfo = null;
  let dragged = false;

  function notifyInput() {
    idleSeconds = 0;
    autoOrbitSpeed = 0;
    if (tween) {
      //Adopt the interrupted position as the new baseline so damping
      //does not jerk the camera toward the cancelled tween's endpoint
      tween = null;
      Object.assign(desired, current);
    }
    onUserInput?.();
  }

  function onPointerDown(e) {
    dom.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      downInfo = { x: e.clientX, y: e.clientY, time: performance.now() };
      dragged = false;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      dragged = true;
    }
    notifyInput();
  }

  function onPointerMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    if (pointers.size === 1) {
      if (downInfo && Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y) > 6) {
        dragged = true;
      }
      const speed = 0.0052;
      desired.azimuth -= dx * speed;
      desired.polar = clamp(desired.polar - dy * speed, lim.minPolar, lim.maxPolar);
      if (dragged) notifyInput();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 0 && d > 0) {
        desired.distance = clamp(
          desired.distance * (pinchDistance / d),
          lim.minDistance,
          lim.maxDistance,
        );
      }
      pinchDistance = d;
      notifyInput();
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    if (pointers.size === 0 && downInfo && !dragged) {
      const elapsed = performance.now() - downInfo.time;
      if (elapsed < 400) onTap?.(e.clientX, e.clientY);
    }
    if (pointers.size === 0) downInfo = null;
  }

  function onWheel(e) {
    e.preventDefault();
    const scale = Math.exp(e.deltaY * 0.0011);
    desired.distance = clamp(desired.distance * scale, lim.minDistance, lim.maxDistance);
    notifyInput();
  }

  dom.addEventListener("pointerdown", onPointerDown);
  dom.addEventListener("pointermove", onPointerMove);
  dom.addEventListener("pointerup", onPointerUp);
  dom.addEventListener("pointercancel", onPointerUp);
  dom.addEventListener("wheel", onWheel, { passive: false });

  function focusOn(point, view, duration = 1.25) {
    targetGoal = { x: point.x, y: point.y, z: point.z };
    tween = {
      t: 0,
      duration: reducedMotion ? Math.min(duration, 0.35) : duration,
      from: {
        azimuth: current.azimuth,
        polar: current.polar,
        distance: current.distance,
        target: targetRef(),
      },
      to: {
        azimuth: current.azimuth + angleDelta(current.azimuth, view.azimuth),
        polar: clamp(view.polar, lim.minPolar, lim.maxPolar),
        distance: clamp(view.distance, lim.minDistance, lim.maxDistance),
        target: { x: point.x, y: point.y, z: point.z },
      },
    };
    desired.azimuth = tween.to.azimuth;
    desired.polar = tween.to.polar;
    desired.distance = tween.to.distance;
  }

  //Small helper so focusOn can snapshot the live target before it changes
  function targetRef() {
    return { x: target.x, y: target.y, z: target.z };
  }

  const controller = {
    focusOn,
    reset(defaults = start) {
      focusOn(
        { x: defaults.target[0], y: defaults.target[1], z: defaults.target[2] },
        { azimuth: defaults.azimuth, polar: defaults.polar, distance: defaults.distance },
        1.35,
      );
    },
    get isTweening() {
      return tween !== null;
    },
    get view() {
      return { azimuth: current.azimuth, polar: current.polar, distance: current.distance };
    },
    dispose() {
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("pointercancel", onPointerUp);
      dom.removeEventListener("wheel", onWheel);
    },
    update(dt) {
      if (tween) {
        tween.t += dt / tween.duration;
        const k = easeInOutCubic(clamp(tween.t, 0, 1));
        current.azimuth = lerp(tween.from.azimuth, tween.to.azimuth, k);
        current.polar = lerp(tween.from.polar, tween.to.polar, k);
        current.distance = lerp(tween.from.distance, tween.to.distance, k);
        target.x = lerp(tween.from.target.x, tween.to.target.x, k);
        target.y = lerp(tween.from.target.y, tween.to.target.y, k);
        target.z = lerp(tween.from.target.z, tween.to.target.z, k);
        if (tween.t >= 1) {
          tween = null;
          Object.assign(desired, {
            azimuth: current.azimuth,
            polar: current.polar,
            distance: current.distance,
          });
        }
      } else {
        //Idle auto-orbit (disabled under reduced motion)
        if (!reducedMotion) {
          idleSeconds += dt;
          const goal = idleSeconds > IDLE_DELAY ? AUTO_SPEED : 0;
          autoOrbitSpeed = damp(autoOrbitSpeed, goal, 1.2, dt);
          desired.azimuth += autoOrbitSpeed * dt;
        }
        const lambda = 9;
        current.azimuth = damp(current.azimuth, desired.azimuth, lambda, dt);
        current.polar = damp(current.polar, desired.polar, lambda, dt);
        current.distance = damp(current.distance, desired.distance, lambda, dt);
        target.x = damp(target.x, targetGoal.x, lambda, dt);
        target.y = damp(target.y, targetGoal.y, lambda, dt);
        target.z = damp(target.z, targetGoal.z, lambda, dt);
      }

      const sp = Math.sin(current.polar);
      camera.position.set(
        target.x + current.distance * sp * Math.sin(current.azimuth),
        target.y + current.distance * Math.cos(current.polar),
        target.z + current.distance * sp * Math.cos(current.azimuth),
      );
      camera.lookAt(target.x, target.y, target.z);
    },
  };

  //Initialize target to the starting goal
  targetGoal = { ...target };

  return controller;
}

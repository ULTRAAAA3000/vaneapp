/* Hero video "ping-pong": plays forward (the pull-back), then backward (the push-in), then forward again, endlessly, so the loop has no cut.
 *
 * A browser cannot play a video backwards, so the reverse half is driven by seeking: the playhead is moved back in step with the clock.
 * Each seek waits for the previous one to finish (never a queue), and the position always follows the wall clock, so a slow device
 * drops frames instead of falling behind: the reverse takes exactly as long as the forward half.
 *
 * Safe by design: the <video> keeps its native `loop` attribute, which is only switched off once this script is running. Anything
 * unexpected (seeking stalls, an error, reduced-motion preference) puts the plain loop back. It pauses while the tab is hidden or
 * the hero is off screen, so it costs nothing then.
 *
 * Use:  <video data-pingpong autoplay loop muted playsinline src="…"></video>
 * Tip:  seeking backwards is smoothest on a video with frequent keyframes. If it ever looks choppy on some device, scripts/make-hero-boomerang.sh
 *       makes a ready-made forward+reverse file to use with the plain `loop` instead (then drop data-pingpong).
 */
(function () {
  'use strict';

  var v = document.querySelector('video[data-pingpong]');
  if (!v) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; // keep the plain loop

  var RATE = 1;            // reverse speed relative to forward (1 = same)
  var END_EPS = 0.04;      // seconds from the start at which the reverse counts as finished
  var STALL_MS = 1500;     // no finished seek for this long = reverse does not work here: fall back to the plain loop
  var reversing = false;
  var suspended = false;   // tab hidden or hero off screen
  var t0 = 0, from = 0;    // reverse clock: started at `t0` (ms) from video time `from` (s)
  var watchdog = 0;
  var gave_up = false;

  v.loop = false;          // from here on, the end of the video is ours (the native loop stays as the fallback)

  function giveUp() {
    gave_up = true;
    reversing = false;
    clearTimeout(watchdog);
    v.loop = true;
    try { v.currentTime = 0; } catch (e) { /* ignore */ }
    var p = v.play();
    if (p && p.catch) p.catch(function () { /* autoplay refused: nothing more to do */ });
  }

  function playForward() {
    reversing = false;
    clearTimeout(watchdog);
    var p = v.play();
    if (p && p.catch) p.catch(function () { /* autoplay refused (the poster stays): nothing to do */ });
  }

  function arm() {
    clearTimeout(watchdog);
    watchdog = setTimeout(function () {
      if (reversing && !suspended) giveUp();
    }, STALL_MS);
  }

  /** One reverse step: jump to where the clock says the playhead should be now. Called again when that seek has finished. */
  function step() {
    if (!reversing || suspended || gave_up) return;
    var target = from - ((performance.now() - t0) / 1000) * RATE;
    if (target <= END_EPS) {
      try { v.currentTime = 0; } catch (e) { return giveUp(); }
      return playForward();
    }
    arm();
    try { v.currentTime = target; } catch (e) { giveUp(); }
  }

  function startReverse() {
    if (gave_up || suspended) return;
    reversing = true;
    from = v.duration || v.currentTime;
    t0 = performance.now();
    v.pause();
    step();
  }

  v.addEventListener('ended', startReverse);
  v.addEventListener('seeked', function () {
    if (reversing) window.requestAnimationFrame(step);
  });
  v.addEventListener('error', function () { clearTimeout(watchdog); reversing = false; });

  // Stop work while nobody can see the video (tab hidden, or scrolled past the hero)
  function setSuspended(s) {
    if (s === suspended || gave_up) return;
    suspended = s;
    if (s) {
      clearTimeout(watchdog);
      v.pause();
    } else if (reversing) {
      from = v.currentTime; t0 = performance.now(); // carry on backwards from where it stopped
      step();
    } else if (!v.ended) {
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* ignore */ });
    } else {
      startReverse();
    }
  }
  var hidden = false, offscreen = false;
  function sync() { setSuspended(hidden || offscreen); }
  document.addEventListener('visibilitychange', function () { hidden = document.hidden; sync(); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      offscreen = !entries[entries.length - 1].isIntersecting;
      sync();
    }, { threshold: 0 }).observe(v);
  }
})();

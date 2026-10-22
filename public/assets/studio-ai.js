/* Vane Studio: AI writer (backend: functions/api/video/ai.ts). Script → titles/description/tags → chapters. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var box = $('aiStudio');
  if (!box || !window.Vane) return;
  var esc = Vane.esc;
  var busy = false, titles = [], pick = 0, meta = null;

  function platform() { return $('aiPlatform').value; }
  function long() { return platform() === 'youtube'; }

  function syncLength() {
    var l = $('aiLength');
    if (long()) { $('aiLengthLabel').textContent = 'Length, minutes'; l.min = 1; l.max = 30; if (!l.dataset.long) { l.value = 5; l.dataset.long = '1'; } }
    else { $('aiLengthLabel').textContent = 'Length, seconds'; l.min = 10; l.max = 60; if (l.dataset.long) { l.value = 30; delete l.dataset.long; } }
    $('aiChapters').classList.toggle('hidden', !long());
  }
  $('aiPlatform').addEventListener('change', syncLength);
  syncLength();

  function seconds() {
    var n = Number($('aiLength').value);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(long() ? n * 60 : n);
  }
  // ── the allowance: 50 generations per plan period; after that the AI stops, or (the user's choice) goes on at $0.02 each
  var lastAi = null;
  function day(sec) { return new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
  function usd(n) { return '$' + n.toFixed(2); }
  function left(ai) {
    if (!ai) return;
    lastAi = ai;
    var ov = ai.overage, pct = ai.limit ? Math.min(100, Math.round(ai.used / ai.limit * 100)) : 100;
    $('aiLeft').textContent = 'Renews ' + day(ai.resetsAt);
    $('aiPlanLine').textContent = ai.used + ' of ' + ai.limit + ' generations used this plan period' + (ai.bonus ? ' · +' + ai.bonus + ' bonus' : '');
    var sub;
    if (ov.enabled) sub = 'Keeping going: every generation after the ' + ai.limit + ' costs ' + usd(ov.priceUsd) + ' and is added to your bill.' + (ov.uses ? ' This period: ' + ov.uses + ' extra, ' + usd(ov.costUsd) + '.' : '') + ' The count starts over on ' + day(ai.resetsAt) + '.';
    else if (ai.remaining > 0) sub = ai.remaining + ' left. The count starts over on ' + day(ai.resetsAt) + '. When they run out the AI stops, unless you switch on “keep going”.';
    else sub = 'All used. The count starts over on ' + day(ai.resetsAt) + '. Switch on “keep going” to continue for ' + usd(ov.priceUsd) + ' per generation.';
    $('aiPlanSub').textContent = sub;
    $('aiOverageText').textContent = 'Keep going at ' + usd(ov.priceUsd) + ' each';
    $('aiOverage').checked = !!ov.enabled;
    $('aiMeter').style.width = pct + '%';
    $('aiMeter').style.background = window.VaneKeys ? VaneKeys.meterColor(pct) : '';
    $('aiMeterBox').setAttribute('aria-valuenow', String(Math.min(ai.used, ai.limit)));
    $('aiMeterBox').setAttribute('aria-valuemax', String(ai.limit));
  }

  /** Turns "keep going" on or off. Switching it on is a billing decision, so it asks first. Resolves to whether it is on now. */
  async function setOverage(on) {
    if (on && lastAi && !window.confirm('Every generation after your ' + lastAi.limit + ' included ones will cost ' + usd(lastAi.overage.priceUsd) + ' and be added to your bill. You can switch this off at any time. Turn it on?')) return false;
    var r = await Vane.api('PATCH', '/api/video/ai', { overage: on });
    if (!r.ok) { Vane.toast('err', r.error); return !on; }
    left(r.data.ai);
    Vane.toast('ok', on ? 'Extra generations are on: ' + usd(r.data.ai.overage.priceUsd) + ' each' : 'The AI will stop when the included generations are used up');
    return on;
  }
  $('aiOverage').addEventListener('change', async function () {
    var want = this.checked;
    this.disabled = true;
    var now = await setOverage(want);
    this.disabled = false;
    this.checked = now;
  });
  function words() {
    var n = ($('aiScript').value.trim().match(/\S+/g) || []).length;
    $('aiWords').textContent = n ? n + ' words · about ' + Math.round(n / 2.5) + ' s spoken' : '';
  }
  $('aiScript').addEventListener('input', words);

  function setBusy(b) { busy = b; ['aiWrite', 'aiMeta', 'aiChapters'].forEach(function (id) { $(id).disabled = b; }); }
  async function call(label, body) {
    if (busy) return null;
    setBusy(true);
    var out = $('aiOut');
    out.classList.remove('hidden');
    out.innerHTML = '<div class="flex items-center gap-2.5 text-sm text-white/60"><span class="spinner"></span> ' + esc(label) + '</div>';
    var r = await Vane.api('POST', '/api/video/ai', body);
    setBusy(false);
    if (r.data && r.data.ai) left(r.data.ai);
    if (!r.ok) {
      var more = r.data && r.data.code === 'ai_quota_exceeded' && lastAi && !lastAi.overage.enabled
        ? '<button id="aiEnable" type="button" class="btn btn-white btn-sm mt-3">Keep going at ' + usd(lastAi.overage.priceUsd) + ' per generation</button>' : '';
      out.innerHTML = '<p class="text-sm text-red-300">' + esc(r.error) + '</p>' + more;
      return null;
    }
    if (r.data.charged && r.data.charged.kind === 'overage') Vane.toast('info', 'Extra generation: ' + usd(r.data.charged.costUsd));
    return r.data;
  }

  $('aiWrite').addEventListener('click', async function () {
    var idea = $('aiIdea').value.trim();
    if (!idea) { Vane.toast('info', 'Write the idea of the video first.'); return; }
    var d = await call('Writing the script…', { tool: 'script', platform: platform(), text: idea, tone: $('aiTone').value || undefined, durationSec: seconds() || undefined });
    if (!d) return;
    $('aiScript').value = d.script; words();
    $('aiOut').innerHTML = '<p class="text-sm text-white/65">Script ready (about ' + d.estimatedSeconds + ' s spoken). Edit it, then make the titles and tags.</p>';
  });

  function copyBtn(text, label) { return '<button type="button" class="btn btn-ghost btn-sm" data-copy="' + esc(text) + '" data-label="' + esc(label) + '">Copy</button>'; }
  function block(title, body, copy, label) {
    return '<div class="rounded-2xl bg-white/[0.04] p-4 ring-1 ring-white/5"><div class="mb-2 flex items-center justify-between gap-3"><span class="text-xs font-semibold uppercase tracking-widest text-white/45">' + esc(title) + '</span>' + (copy ? copyBtn(copy, label || title) : '') + '</div>' + body + '</div>';
  }

  $('aiMeta').addEventListener('click', async function () {
    var script = $('aiScript').value.trim() || $('aiIdea').value.trim();
    if (!script) { Vane.toast('info', 'Write or paste the script first.'); return; }
    var d = await call('Writing titles and tags…', { tool: 'metadata', platform: platform(), text: script });
    if (!d) return;
    meta = d; titles = d.titles; pick = 0;
    var yt = long() || platform() === 'shorts';
    var html = block(yt ? 'Titles' : 'Captions', '<div class="space-y-1.5">' + d.titles.map(function (t, i) {
      return '<label class="flex cursor-pointer items-start gap-2 text-sm text-white/85"><input type="radio" name="aiTitle" value="' + i + '"' + (i === 0 ? ' checked' : '') + ' class="mt-1" /><span>' + esc(t) + '</span></label>';
    }).join('') + '</div>');
    if (d.description) html += block('Description', '<p class="whitespace-pre-wrap text-sm leading-relaxed text-white/85">' + esc(d.description) + '</p>', d.description, 'Description');
    if (d.tags.length) html += block('Tags', '<p class="text-sm text-white/85">' + d.tags.map(esc).join(', ') + '</p>', d.tags.join(', '), 'Tags');
    if (d.hashtags.length) html += block('Hashtags', '<p class="text-sm text-white/85">' + d.hashtags.map(esc).join(' ') + '</p>', d.hashtags.join(' '), 'Hashtags');
    html += '<button id="aiFill" type="button" class="btn btn-white btn-sm">Use in the upload form</button>';
    $('aiOut').innerHTML = html;
  });

  $('aiChapters').addEventListener('click', async function () {
    var script = $('aiScript').value.trim();
    if (!script) { Vane.toast('info', 'Paste the full script first: chapters are made from it.'); return; }
    var sec = seconds();
    if (!sec) { Vane.toast('info', 'Set the length of the video in minutes.'); return; }
    var d = await call('Making chapters…', { tool: 'chapters', platform: 'youtube', text: script, durationSec: sec });
    if (!d) return;
    var text = d.chapters.map(function (c) { return c.time + ' ' + c.title; }).join('\n');
    $('aiOut').innerHTML = block('Chapters', '<pre class="whitespace-pre-wrap font-sans text-sm leading-relaxed text-white/85">' + esc(text) + '</pre>', text, 'Chapters') +
      '<p class="text-xs text-white/40">The times are an estimate from where each part sits in the script. Check them against your edit before you publish.</p>' +
      '<button id="aiAddChapters" type="button" class="btn btn-ghost btn-sm">Add to the description</button>';
    $('aiOut').dataset.chapters = text;
  });

  $('aiOut').addEventListener('click', async function (e) {
    if (e.target.closest('#aiEnable')) {
      if (await setOverage(true)) $('aiOut').innerHTML = '<p class="text-sm text-white/65">Extra generations are on. Press the button again to continue.</p>';
      return;
    }
    var c = e.target.closest('[data-copy]');
    if (c && window.VaneKeys) { VaneKeys.copyWithToast(c.getAttribute('data-copy'), c.getAttribute('data-label') || 'Text'); return; }
    if (e.target.closest('#aiFill') && meta) {
      var sel = $('aiOut').querySelector('input[name=aiTitle]:checked');
      var t = meta.titles[sel ? Number(sel.value) : 0] || '';
      if ($('upTitle')) $('upTitle').value = t.slice(0, 100);
      var tagLine = meta.hashtags.length ? '\n\n' + meta.hashtags.join(' ') : '';
      if ($('upDesc')) $('upDesc').value = (meta.description || (t + tagLine)).slice(0, 5000);
      if ($('upTags')) $('upTags').value = (meta.tags.length ? meta.tags : meta.hashtags.map(function (h) { return h.replace(/^#/, ''); })).join(', ');
      Vane.toast('ok', 'Filled in the upload form');
      return;
    }
    if (e.target.closest('#aiAddChapters')) {
      var ch = $('aiOut').dataset.chapters || '';
      if ($('upDesc') && ch) { $('upDesc').value = (($('upDesc').value.trim() ? $('upDesc').value.trim() + '\n\n' : '') + ch).slice(0, 5000); Vane.toast('ok', 'Added to the description'); }
    }
  });

  $('aiCopyScript').addEventListener('click', function () {
    var t = $('aiScript').value.trim();
    if (!t) { Vane.toast('info', 'Nothing to copy yet.'); return; }
    if (window.VaneKeys) VaneKeys.copyWithToast(t, 'Script');
  });

  // Show the writer only for accounts with Vane Studio on a server that has AI.
  Vane.api('GET', '/api/video/ai', undefined, { noRedirect: true }).then(function (r) {
    if (!r.ok || !r.data || !r.data.available) return;
    left(r.data.ai);
    box.classList.remove('hidden');
  });
})();

(function () {
  'use strict';
  var root = document.getElementById('aiStudio');
  if (!root || !window.Vane || !Vane.composer) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = Vane.esc;
  var S = { tool: 'generate', tone: 'professional', busy: false, voice: null, ready: false, result: null, queue: null };
  var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var NAMES = { telegram: 'Telegram', linkedin: 'LinkedIn', bluesky: 'Bluesky', mastodon: 'Mastodon', discord: 'Discord', devto: 'Dev.to', threads: 'Threads', reddit: 'Reddit', pinterest: 'Pinterest', facebook: 'Facebook', x: 'X', webhook: 'Webhook' };
  var TONES = [['mine', 'My voice'], ['professional', 'Professional'], ['viral', 'Viral'], ['friendly', 'Friendly'], ['tech', 'Tech / indie']];
  var TOOLS = [
    { id: 'generate', group: 'Create', title: 'Write from an idea', desc: 'A full post from one line', hint: 'Your idea, in a line or two: “we shipped dark mode today”' },
    { id: 'winners', group: 'Create', title: 'Like my best posts', desc: 'New posts built on what worked for you', hint: 'What should the new posts be about?' },
    { id: 'plan', group: 'Create', title: 'Plan my week', desc: 'Seven posts, one a day, ready to queue', hint: 'The project or topic for the week' },
    { id: 'repurpose', group: 'Create', title: 'One text, four posts', desc: 'Turn an article into a short series', hint: 'Paste the article, announcement or long post' },
    { id: 'tone', group: 'Improve', title: 'Rewrite', desc: 'Change the tone, or use your own voice', hint: 'The post you want to rewrite' },
    { id: 'hook', group: 'Improve', title: 'Opening lines', desc: 'Three ways to start', hint: 'Your post' },
    { id: 'cta', group: 'Improve', title: 'Call to action', desc: 'Three ways to end', hint: 'Your post' },
    { id: 'reformat', group: 'Improve', title: 'Version per channel', desc: 'Fits every channel you pick in Create', hint: 'Your post' }
  ];
  var byId = {};
  TOOLS.forEach(function (t) { byId[t.id] = t; });

  root.innerHTML =
    '<div class="flex flex-wrap items-start justify-between gap-3">' +
      '<div><h2 id="aiTitle" class="text-lg font-semibold tracking-tight">AI</h2>' +
      '<p class="mt-1 max-w-2xl text-xs leading-relaxed text-white/45">Posts in your own voice, based on what worked for you, planned for the week and queued at your best times. Make it clean and Hashtags stay free in the editor.</p></div>' +
      '<span id="aiCredits2" class="rounded-full bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-white/60"></span></div>' +
    '<div id="aiOff" class="mt-4 hidden rounded-xl border border-amber-300/20 bg-amber-400/10 p-3 text-sm text-amber-200">AI is not enabled on this server yet.</div>' +
    '<div id="aiBanner" class="mt-4 hidden"></div>' +
    '<div class="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">' +
      '<div>' +
        '<div id="aiTools" class="grid gap-2 sm:grid-cols-2"></div>' +
        '<div id="aiToneRow" class="mt-3 hidden flex-wrap gap-1.5" role="group" aria-label="Tone"></div>' +
        '<label for="aiInput" class="sr-only">Text for AI</label>' +
        '<textarea id="aiInput" rows="6" maxlength="5000" class="field mt-3 resize-none !rounded-2xl !p-4 !text-[15px] leading-relaxed"></textarea>' +
        '<div class="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-white/50">' +
          '<span id="aiFor"></span>' +
          '<button id="aiVoiceChip" type="button" class="chip" aria-pressed="true"><span>Use my voice</span></button></div>' +
        '<div class="mt-3 flex flex-wrap items-center gap-2"><button id="aiRun" type="button" class="btn btn-white">Go</button>' +
          '<button id="aiFromEditor" type="button" class="btn btn-ghost btn-sm">Take text from the editor</button></div>' +
      '</div>' +
      '<div id="aiOut" class="min-w-0" aria-live="polite"><div class="rounded-2xl border border-dashed border-white/10 p-6 text-sm text-white/40">The result appears here. Every answer is also kept in your history below.</div></div>' +
    '</div>' +
    '<details id="aiVoiceBox" class="mt-7 rounded-2xl border border-white/10 p-4">' +
      '<summary class="cursor-pointer text-sm font-semibold">My voice <span id="aiVoiceState" class="ml-2 text-xs font-normal text-white/45"></span></summary>' +
      '<p class="mt-2 max-w-2xl text-xs leading-relaxed text-white/50">Add a few of your own posts and a line about your style, and everything the AI writes sounds like you, not like a chatbot. Without examples, Vane learns from the posts you sent through it.</p>' +
      '<label for="aiVoiceDesc" class="mt-4 block text-xs font-medium text-white/60">Your style in a line</label>' +
      '<input id="aiVoiceDesc" class="field mt-1.5" maxlength="400" placeholder="short, dry, no exclamation marks, lowercase titles" />' +
      '<div class="mt-4 text-xs font-medium text-white/60">Example posts <span class="text-white/35">(up to 5)</span></div>' +
      '<div id="aiVoiceSamples" class="mt-1.5 space-y-2"></div>' +
      '<div class="mt-3 flex flex-wrap items-center gap-2"><button id="aiVoiceAdd" type="button" class="btn btn-ghost btn-sm">Add an example</button>' +
        '<button id="aiVoiceSave" type="button" class="btn btn-white btn-sm">Save my voice</button>' +
        '<button id="aiVoiceOff" type="button" class="chip" aria-pressed="false"><span>Turn voice off everywhere</span></button></div>' +
    '</details>' +
    '<div class="mt-7"><h3 class="text-sm font-semibold">History</h3>' +
      '<p class="mt-1 text-xs text-white/45">The latest posts, plans and series written by AI. We keep the last 10; pin up to 4 to keep them.</p>' +
      '<div id="histList" class="mt-4 space-y-3" aria-live="polite"></div></div>';

  function networks() { return Vane.composer.networks(); }
  function label(p) { return NAMES[p] || p; }

  function renderTools() {
    var groups = {};
    TOOLS.forEach(function (t) { (groups[t.group] = groups[t.group] || []).push(t); });
    $('aiTools').innerHTML = TOOLS.map(function (t) {
      return '<button type="button" class="ai-tool" data-tool="' + t.id + '" aria-pressed="' + (S.tool === t.id) + '"><span><span class="ai-t">' + esc(t.title) + '</span><span class="ai-d">' + esc(t.desc) + '</span></span></button>';
    }).join('');
    $('aiToneRow').classList.toggle('hidden', S.tool !== 'tone');
    $('aiToneRow').classList.toggle('flex', S.tool === 'tone');
    $('aiToneRow').innerHTML = TONES.map(function (t) { return '<button type="button" class="chip" data-tone="' + t[0] + '" aria-pressed="' + (S.tone === t[0]) + '"><span>' + t[1] + '</span></button>'; }).join('');
    $('aiInput').placeholder = byId[S.tool].hint;
    $('aiInput').maxLength = (S.tool === 'generate' || S.tool === 'plan' || S.tool === 'winners') ? 1500 : 5000;
    var n = networks();
    $('aiFor').textContent = n.length ? 'For: ' + n.map(label).join(', ') + ' (change under Publish to in Create)' : 'No channel chosen in Create: texts are sized for any network.';
  }

  function voiceChip() {
    var on = !!(S.voice && S.voice.enabled);
    $('aiVoiceChip').setAttribute('aria-pressed', String(S.useVoice !== false && on));
    $('aiVoiceChip').classList.toggle('hidden', !on);
    $('aiVoiceOff').setAttribute('aria-pressed', String(!on));
    $('aiVoiceOff').firstChild.textContent = on ? 'Turn voice off everywhere' : 'Voice is off: turn it on';
    var v = S.voice;
    $('aiVoiceState').textContent = !v ? '' : !on ? 'off' : v.samples.length || v.description ? 'set up' : v.learnedFromPosts ? 'learning from your sent posts' : 'not set up yet';
  }

  function sampleRow(text) {
    return '<div class="flex gap-2"><textarea rows="2" maxlength="600" class="field min-w-0 flex-1 resize-none !rounded-xl !p-3 text-sm" data-sample>' + esc(text || '') + '</textarea>' +
      '<button type="button" class="icon-btn !h-8 !w-8" data-voice-del aria-label="Remove example">✕</button></div>';
  }
  function renderVoice() {
    var v = S.voice;
    if (!v) return;
    $('aiVoiceDesc').value = v.description || '';
    $('aiVoiceSamples').innerHTML = v.samples.map(sampleRow).join('');
    $('aiVoiceAdd').classList.toggle('hidden', v.samples.length >= 5);
    voiceChip();
  }
  function collectSamples() {
    return [].map.call($('aiVoiceSamples').querySelectorAll('[data-sample]'), function (t) { return t.value.trim(); }).filter(function (x) { return x.length >= 10; });
  }

  function setBusy(b) { S.busy = b; $('aiRun').disabled = b; $('aiRun').textContent = b ? 'Working…' : 'Go'; }
  function out(html) { $('aiOut').innerHTML = html; }
  function card(title, body) {
    return '<div class="ai-solid rounded-2xl p-4"><div class="mb-3 text-xs font-semibold uppercase tracking-widest text-white/45">' + esc(title) + '</div>' + body + '</div>';
  }
  function textBox(t) { return '<p class="whitespace-pre-wrap rounded-xl border border-white/10 bg-[#1a1a1f] p-3 text-sm leading-relaxed text-white/90">' + esc(t) + '</p>'; }
  function actions(i, extra) {
    return '<div class="mt-2 flex flex-wrap gap-2"><button type="button" class="btn btn-white btn-sm" data-act="use" data-i="' + i + '">Use in editor</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="copy" data-i="' + i + '">Copy</button>' + (extra || '') + '</div>';
  }

  function texts(r) {
    if (r.tool === 'generate' || r.tool === 'tone') return [r.text];
    if (r.tool === 'plan' || r.tool === 'repurpose') return r.items.map(function (x) { return x.text; });
    if (r.tool === 'reformat') return r.variants.map(function (v) { return v.text; });
    return r.options || [];
  }

  function showResult(r) {
    S.result = r;
    var t = texts(r), body = '', title = byId[r.tool].title;
    var note = r.voice ? '<p class="mt-3 text-xs text-white/40">Written in ' + (r.voice === 'manual' ? 'your voice' : 'the style of your recent posts') + '.</p>' : '';
    if (r.tool === 'generate' || r.tool === 'tone') body = textBox(t[0]) + actions(0);
    else if (r.tool === 'plan' || r.tool === 'repurpose') {
      body = '<div class="space-y-3">' + r.items.map(function (it, i) {
        return '<div><div class="mb-1 text-[11px] font-medium uppercase tracking-widest text-white/40">' + (r.tool === 'plan' ? DAYS[it.day] : 'Post ' + (it.day + 1)) + '</div>' + textBox(it.text) + actions(i) + '</div>';
      }).join('') + '</div>' +
        '<div class="mt-4 border-t border-white/10 pt-4"><button type="button" class="btn btn-white btn-sm" data-act="queue">Put these in my queue…</button>' +
        '<p class="mt-2 text-xs text-white/40">Vane picks the days and times, you see them before anything is scheduled.</p></div>';
    } else if (r.tool === 'reformat') {
      body = '<div class="space-y-3">' + r.variants.map(function (v, i) {
        return '<div class="rounded-xl border border-white/10 bg-[#1a1a1f] p-3"><div class="mb-1.5 flex items-center justify-between text-xs"><span class="font-medium text-white/80">' + esc(label(v.platform)) + '</span><span class="' + (v.length > v.limit ? 'text-red-300' : 'text-white/40') + '">' + v.length + ' / ' + v.limit + '</span></div>' +
          '<p class="whitespace-pre-wrap text-sm leading-relaxed text-white/85">' + esc(v.text) + '</p>' + actions(i) + '</div>';
      }).join('') + '</div>';
    } else {
      body = '<div class="space-y-3">' + t.map(function (o, i) { return '<div>' + textBox(o) + actions(i, r.tool === 'winners' ? '<button type="button" class="btn btn-ghost btn-sm" data-act="queue1" data-i="' + i + '">Queue</button>' : '') + '</div>'; }).join('') + '</div>';
      if (r.tool === 'winners') note = '<p class="mt-3 text-xs text-white/40">Based on your ' + (r.measured ? r.basedOn + ' best-performing posts.' : r.basedOn + ' latest posts (no results measured yet).') + '</p>' + note;
    }
    out(card(title, body + note));
  }

  function showError(title, msg) { out(card(title, '<p class="text-sm text-red-300">' + esc(msg) + '</p>')); }

  async function run() {
    if (S.busy) return;
    var tool = S.tool, text = $('aiInput').value.trim();
    if (!text) { Vane.toast('info', byId[tool].hint); $('aiInput').focus(); return; }
    var n = networks();
    if (tool === 'reformat' && !n.length) { Vane.toast('info', 'Pick the channels under Publish to in Create first.'); return; }
    var body = { tool: tool, text: text, networks: n };
    if (tool === 'tone') body.tone = S.tone;
    if (S.useVoice === false) body.voice = false;
    setBusy(true);
    out('<div class="ai-solid flex items-center gap-2.5 rounded-2xl p-4 text-sm text-white/60"><span class="spinner"></span> Working…</div>');
    var r = await Vane.api('POST', '/api/ai', body);
    setBusy(false);
    if (r.data && r.data.ai) document.dispatchEvent(new CustomEvent('vane:aiupdate', { detail: r.data.ai }));
    if (!r.ok) { showError(byId[tool].title, r.error); return; }
    showResult(r.data);
    document.dispatchEvent(new CustomEvent('vane:history'));
  }

  function pick(i) { return texts(S.result)[i]; }

  function timeLabel(ts) {
    try { return new Date(ts * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return String(ts); }
  }

  async function openQueue(items) {
    var st = Vane.composer.state();
    if (!st.channelIds.length) { Vane.toast('info', 'Pick the channels under Publish to in Create first, then come back.'); return; }
    var r = await Vane.api('GET', '/api/ai/slots?count=' + items.length);
    if (!r.ok) { Vane.toast('err', r.error); return; }
    S.queue = { items: items, slots: r.data.slots, channelIds: st.channelIds };
    var chans = networks().map(label).join(', ');
    out(card('Your queue',
      '<p class="mb-3 text-xs text-white/50">To: ' + esc(chans) + '. ' + (r.data.personal ? 'Times come from when your posts did best.' : 'Morning times: your own best times appear after a few measured posts.') + '</p>' +
      '<div class="space-y-2">' + items.map(function (t, i) { return '<div class="rounded-xl border border-white/10 bg-[#1a1a1f] p-3"><div class="mb-1 text-[11px] font-medium uppercase tracking-widest text-white/40">' + esc(timeLabel(r.data.slots[i])) + '</div><p class="text-sm leading-relaxed text-white/85">' + esc(t.length > 220 ? t.slice(0, 220) + '…' : t) + '</p></div>'; }).join('') + '</div>' +
      '<div class="mt-4 flex flex-wrap gap-2"><button type="button" class="btn btn-white btn-sm" data-act="schedule">Schedule ' + items.length + ' post' + (items.length === 1 ? '' : 's') + '</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="back">Back</button></div>'));
  }

  async function schedule() {
    var q = S.queue;
    if (!q || S.busy) return;
    setBusy(true);
    var ok = 0, err = '';
    for (var i = 0; i < q.items.length; i++) {
      var r = await Vane.api('POST', '/api/posts', { content: q.items[i], channelIds: q.channelIds, scheduledAt: q.slots[i] });
      if (r.ok) ok++; else { err = r.error; break; }
    }
    setBusy(false);
    S.queue = null;
    document.dispatchEvent(new CustomEvent('vane:scheduled'));
    out(card(err ? 'Partly scheduled' : 'Scheduled',
      '<p class="text-sm text-white/80">' + ok + ' of ' + q.items.length + ' post' + (q.items.length === 1 ? '' : 's') + ' are in your queue.</p>' + (err ? '<p class="mt-2 text-sm text-red-300">' + esc(err) + '</p>' : '')));
    if (!err) Vane.toast('ok', ok + ' scheduled.');
  }

  root.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-tool]');
    if (t) { S.tool = t.getAttribute('data-tool'); renderTools(); return; }
    var tn = e.target.closest('[data-tone]');
    if (tn) { S.tone = tn.getAttribute('data-tone'); renderTools(); return; }
    if (e.target.closest('#aiRun')) { run(); return; }
    if (e.target.closest('#aiFromEditor')) { $('aiInput').value = Vane.composer.text(); return; }
    if (e.target.closest('#aiVoiceChip')) { S.useVoice = S.useVoice === false; voiceChip(); return; }
    if (e.target.closest('#aiVoiceAdd')) { $('aiVoiceSamples').insertAdjacentHTML('beforeend', sampleRow('')); $('aiVoiceAdd').classList.toggle('hidden', $('aiVoiceSamples').children.length >= 5); return; }
    var del = e.target.closest('[data-voice-del]');
    if (del) { del.parentElement.remove(); $('aiVoiceAdd').classList.remove('hidden'); return; }
    if (e.target.closest('#aiVoiceSave')) {
      var r = await Vane.api('POST', '/api/ai/voice', { description: $('aiVoiceDesc').value, samples: collectSamples() });
      if (!r.ok) { Vane.toast('err', r.error); return; }
      S.voice = Object.assign({}, S.voice, r.data); renderVoice(); Vane.toast('ok', 'Your voice is saved.');
      return;
    }
    if (e.target.closest('#aiVoiceOff')) {
      var on = !(S.voice && S.voice.enabled);
      var v = await Vane.api('POST', '/api/ai/voice', { enabled: on });
      if (!v.ok) { Vane.toast('err', v.error); return; }
      S.voice = Object.assign({}, S.voice, v.data); renderVoice();
      return;
    }
    var b = e.target.closest('#aiOut [data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act'), i = Number(b.getAttribute('data-i') || 0);
    if (act === 'use') {
      var txt = pick(i);
      if (S.result.tool === 'hook') txt = txt + '\n\n' + Vane.composer.text();
      else if (S.result.tool === 'cta') txt = Vane.composer.text().replace(/\s+$/, '') + '\n\n' + txt;
      Vane.composer.set(txt);
      location.hash = '#create';
    } else if (act === 'copy') {
      try { await navigator.clipboard.writeText(pick(i)); Vane.toast('ok', 'Copied.'); } catch (err) { Vane.toast('err', 'Could not copy.'); }
    } else if (act === 'queue') openQueue(texts(S.result));
    else if (act === 'queue1') openQueue([pick(i)]);
    else if (act === 'schedule') schedule();
    else if (act === 'back') showResult(S.result);
  });

  $('aiInput').addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); });

  async function open() {
    renderTools();
    if (!$('aiInput').value.trim() && Vane.composer.text().trim()) $('aiInput').value = Vane.composer.text();
    if (!S.ready) {
      S.ready = true;
      var a = await Vane.api('GET', '/api/ai', undefined, { noRedirect: true });
      if (a.ok && a.data) { $('aiOff').classList.toggle('hidden', !!a.data.available); if (a.data.available) document.dispatchEvent(new CustomEvent('vane:aiupdate', { detail: a.data.ai })); }
      var v = await Vane.api('GET', '/api/ai/voice', undefined, { noRedirect: true });
      if (v.ok) { S.voice = v.data; renderVoice(); }
    }
    document.dispatchEvent(new CustomEvent('vane:history'));
  }

  document.addEventListener('vane:ai', open);
  if (location.hash === '#ai' || location.hash === '#history') open();
})();

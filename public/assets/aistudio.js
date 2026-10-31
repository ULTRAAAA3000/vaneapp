(function () {
  'use strict';
  var root = document.getElementById('aiStudio');
  if (!root || !window.Vane || !Vane.composer) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = Vane.esc;
  var S = { tool: 'generate', tone: 'professional', lang: 'en', picked: null, busy: false, voice: null, useVoice: true, ready: false, result: null, queue: null };
  var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var NAMES = { telegram: 'Telegram', linkedin: 'LinkedIn', bluesky: 'Bluesky', mastodon: 'Mastodon', discord: 'Discord', devto: 'Dev.to', threads: 'Threads', reddit: 'Reddit', pinterest: 'Pinterest', facebook: 'Facebook', x: 'X', webhook: 'Webhook' };
  var TONES = [['mine', 'My voice'], ['professional', 'Professional'], ['viral', 'Viral'], ['friendly', 'Friendly'], ['tech', 'Tech / indie']];
  var LANGS = [['en', 'English'], ['uk', 'Українська'], ['ru', 'Русский'], ['de', 'Deutsch'], ['es', 'Español'], ['fr', 'Français'], ['pl', 'Polski'], ['it', 'Italiano'], ['pt', 'Português'], ['tr', 'Türkçe']];
  var TOOLS = [
    { id: 'generate', group: 'Create', title: 'Write from an idea', desc: 'A full post from one line', hint: 'Your idea, in a line or two: “we shipped dark mode today”' },
    { id: 'ideas', group: 'Create', title: 'What to post next', desc: 'Ideas from your own posts and queue', hint: 'Optional: your focus, e.g. “my indie SaaS for freelancers”', optional: true },
    { id: 'winners', group: 'Create', title: 'Like my best posts', desc: 'New posts built on what worked for you', hint: 'What should the new posts be about?' },
    { id: 'plan', group: 'Create', title: 'Plan my week', desc: 'Seven posts, one a day, ready to queue', hint: 'The project or topic for the week' },
    { id: 'repurpose', group: 'Create', title: 'One text, four posts', desc: 'Turn an article into a short series', hint: 'Paste the article, announcement or long post' },
    { id: 'review', group: 'Improve', title: 'Check before sending', desc: 'Score, fixes and a better version', hint: 'The post to check' },
    { id: 'tone', group: 'Improve', title: 'Rewrite', desc: 'Change the tone, or use your own voice', hint: 'The post you want to rewrite' },
    { id: 'translate', group: 'Improve', title: 'Translate', desc: 'Same post in another language', hint: 'The post to translate' },
    { id: 'hook', group: 'Improve', title: 'Opening lines', desc: 'Three ways to start', hint: 'Your post' },
    { id: 'cta', group: 'Improve', title: 'Call to action', desc: 'Three ways to end', hint: 'Your post' },
    { id: 'reformat', group: 'Improve', title: 'Version per channel', desc: 'One text per channel you pick', hint: 'Your post' }
  ];
  var byId = {};
  TOOLS.forEach(function (t) { byId[t.id] = t; });
  var SHORT = { generate: 1500, ideas: 1500, winners: 1500, plan: 1500 };

  root.innerHTML =
    '<div class="flex flex-wrap items-start justify-between gap-3">' +
      '<div><h2 id="aiTitle" class="text-lg font-semibold tracking-tight">AI</h2>' +
      '<p class="mt-1 max-w-2xl text-xs leading-relaxed text-white/45">Posts in your own voice, based on what worked for you, checked before they go out, planned and queued at times you control. Make it clean and Hashtags stay free in the editor.</p></div>' +
      '<span id="aiCredits2" class="rounded-full bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-white/60"></span></div>' +
    '<div id="aiOff" class="mt-4 hidden rounded-xl border border-amber-300/20 bg-amber-400/10 p-3 text-sm text-amber-200">AI is not enabled on this server yet.</div>' +
    '<div id="aiBanner" class="mt-4 hidden"></div>' +
    '<div class="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">' +
      '<div>' +
        '<div id="aiTools"></div>' +
        '<div id="aiOptRow" class="mt-3 hidden flex-wrap gap-1.5" role="group"></div>' +
        '<label for="aiInput" class="sr-only">Text for AI</label>' +
        '<textarea id="aiInput" rows="6" maxlength="5000" class="field mt-3 resize-none !rounded-2xl !p-4 !text-[15px] leading-relaxed"></textarea>' +
        '<div class="mt-3"><div class="mb-1.5 flex items-center justify-between gap-3 text-[11px] font-medium uppercase tracking-widest text-white/40"><span>Channels</span><span id="aiChanNote" class="normal-case tracking-normal text-white/35"></span></div>' +
          '<div id="aiChans" class="flex flex-wrap gap-1.5" role="group" aria-label="Channels for this text"></div></div>' +
        '<div class="mt-3 flex flex-wrap items-center gap-2"><button id="aiRun" type="button" class="btn btn-white">Go</button>' +
          '<button id="aiFromEditor" type="button" class="btn btn-ghost btn-sm">Take text from the editor</button>' +
          '<button id="aiVoiceChip" type="button" class="chip ml-auto" aria-pressed="true"><span>Use my voice</span></button></div>' +
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
      '<p class="mt-1 text-xs text-white/45">The latest posts, plans, ideas and translations written by AI. We keep the last 10; pin up to 4 to keep them.</p>' +
      '<div id="histList" class="mt-4 space-y-3" aria-live="polite"></div></div>';

  function label(p) { return NAMES[p] || p; }
  function channels() { return Vane.composer.channels(); }
  function pickedSet() {
    if (!S.picked) {
      var all = channels();
      if (!all.length) return new Set();
      var sel = all.filter(function (c) { return c.selected; });
      S.picked = new Set((sel.length ? sel : all).map(function (c) { return c.id; }));
    }
    var own = {};
    channels().forEach(function (c) { own[c.id] = 1; });
    S.picked.forEach(function (id) { if (!own[id]) S.picked.delete(id); });
    return S.picked;
  }
  function pickedChannels() { var p = pickedSet(); return channels().filter(function (c) { return p.has(c.id); }); }
  function networks() { var seen = {}; return pickedChannels().map(function (c) { return c.platform; }).filter(function (x) { return !seen[x] && (seen[x] = 1); }); }

  function renderChans() {
    var all = channels(), p = pickedSet();
    $('aiChans').innerHTML = all.length ? all.map(function (c) {
      return '<button type="button" class="chip" data-chan="' + esc(c.id) + '" aria-pressed="' + p.has(c.id) + '"><span>' + esc(c.name) + '</span><span class="text-white/40">' + esc(label(c.platform)) + '</span></button>';
    }).join('') : '<span class="text-xs text-white/45">No channels connected yet. Connect one in the Channels card on the Create tab.</span>';
    $('aiChanNote').textContent = all.length ? (p.size ? 'texts are sized for ' + networks().map(label).join(', ') : 'none picked: sized for any network') : '';
  }

  function renderTools() {
    var html = '';
    ['Create', 'Improve'].forEach(function (g) {
      html += '<div class="' + (g === 'Create' ? '' : 'mt-4 ') + 'mb-1.5 text-[11px] font-medium uppercase tracking-widest text-white/40">' + g + '</div><div class="grid gap-2 sm:grid-cols-2">' +
        TOOLS.filter(function (t) { return t.group === g; }).map(function (t) {
          return '<button type="button" class="ai-tool" data-tool="' + t.id + '" aria-pressed="' + (S.tool === t.id) + '"><span><span class="ai-t">' + esc(t.title) + '</span><span class="ai-d">' + esc(t.desc) + '</span></span></button>';
        }).join('') + '</div>';
    });
    $('aiTools').innerHTML = html;
    var row = $('aiOptRow'), kind = S.tool === 'tone' ? 'tone' : S.tool === 'translate' ? 'lang' : '';
    row.classList.toggle('hidden', !kind);
    row.classList.toggle('flex', !!kind);
    row.setAttribute('aria-label', kind === 'tone' ? 'Tone' : 'Language');
    row.innerHTML = kind === 'tone'
      ? TONES.map(function (t) { return '<button type="button" class="chip" data-tone="' + t[0] + '" aria-pressed="' + (S.tone === t[0]) + '"><span>' + t[1] + '</span></button>'; }).join('')
      : kind === 'lang' ? LANGS.map(function (t) { return '<button type="button" class="chip" data-lang="' + t[0] + '" aria-pressed="' + (S.lang === t[0]) + '"><span>' + t[1] + '</span></button>'; }).join('') : '';
    $('aiInput').placeholder = byId[S.tool].hint;
    $('aiInput').maxLength = SHORT[S.tool] || 5000;
    renderChans();
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
  function actions(i, extra, noQueue) {
    return '<div class="mt-2 flex flex-wrap gap-2"><button type="button" class="btn btn-white btn-sm" data-act="use" data-i="' + i + '">Use in editor</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="copy" data-i="' + i + '">Copy</button>' +
      (noQueue ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-act="queue1" data-i="' + i + '">Schedule…</button>') + (extra || '') + '</div>';
  }

  function texts(r) {
    if (r.tool === 'generate' || r.tool === 'tone' || r.tool === 'translate') return [r.text];
    if (r.tool === 'plan' || r.tool === 'repurpose') return r.items.map(function (x) { return x.text; });
    if (r.tool === 'reformat') return r.variants.map(function (v) { return v.text; });
    if (r.tool === 'review') return r.better ? [r.better] : [];
    return r.options || [];
  }

  function scoreTone(n) { return n >= 8 ? 'bg-emerald-400/15 text-emerald-300' : n >= 5 ? 'bg-amber-400/15 text-amber-200' : 'bg-red-400/15 text-red-300'; }
  var DOT = { ok: 'text-emerald-400', warn: 'text-amber-300', bad: 'text-red-400' };

  function showResult(r) {
    S.result = r;
    var t = texts(r), body = '', title = byId[r.tool].title;
    var note = r.voice ? '<p class="mt-3 text-xs text-white/40">Written in ' + (r.voice === 'manual' ? 'your voice' : 'the style of your recent posts') + '.</p>' : '';
    if (r.tool === 'generate' || r.tool === 'tone') body = textBox(t[0]) + actions(0);
    else if (r.tool === 'translate') { var ln = LANGS.filter(function (x) { return x[0] === r.lang; })[0]; title = 'Translated to ' + (ln ? ln[1] : r.lang); body = textBox(t[0]) + actions(0); }
    else if (r.tool === 'plan' || r.tool === 'repurpose') {
      body = '<div class="space-y-3">' + r.items.map(function (it, i) {
        return '<div><div class="mb-1 text-[11px] font-medium uppercase tracking-widest text-white/40">' + (r.tool === 'plan' ? DAYS[it.day] : 'Post ' + (it.day + 1)) + '</div>' + textBox(it.text) + actions(i) + '</div>';
      }).join('') + '</div>' +
        '<div class="mt-4 border-t border-white/10 pt-4"><button type="button" class="btn btn-white btn-sm" data-act="queue">Put these in my queue…</button>' +
        '<p class="mt-2 text-xs text-white/40">Vane suggests the days and times. You change anything before it is scheduled.</p></div>';
    } else if (r.tool === 'reformat') {
      body = '<div class="space-y-3">' + r.variants.map(function (v, i) {
        return '<div class="rounded-xl border border-white/10 bg-[#1a1a1f] p-3"><div class="mb-1.5 flex items-center justify-between text-xs"><span class="font-medium text-white/80">' + esc(label(v.platform)) + '</span><span class="' + (v.length > v.limit ? 'text-red-300' : 'text-white/40') + '">' + v.length + ' / ' + v.limit + '</span></div>' +
          '<p class="whitespace-pre-wrap text-sm leading-relaxed text-white/85">' + esc(v.text) + '</p>' + actions(i, '', true) + '</div>';
      }).join('') + '</div>' +
        '<div class="mt-4 border-t border-white/10 pt-4"><button type="button" class="btn btn-white btn-sm" data-act="queue">Schedule all versions…</button>' +
        '<p class="mt-2 text-xs text-white/40">Each version goes only to its own channels, at the time you choose.</p></div>';
    } else if (r.tool === 'review') {
      body = '<div class="flex items-center gap-3"><span class="rounded-full px-3 py-1 text-sm font-semibold ' + scoreTone(r.score) + '">' + r.score + ' / 10</span><span class="text-xs text-white/45">' + (r.score >= 8 ? 'Ready to go' : r.score >= 5 ? 'Good, can be sharper' : 'Needs work') + '</span></div>' +
        '<ul class="mt-3 space-y-1.5 text-sm">' + r.checks.map(function (c) { return '<li class="flex gap-2"><span class="' + DOT[c.level] + '">●</span><span class="text-white/75">' + esc(c.text) + '</span></li>'; }).join('') + '</ul>' +
        '<div class="mt-4 text-[11px] font-medium uppercase tracking-widest text-white/40">What to change</div>' +
        '<ul class="mt-1.5 list-disc space-y-1 pl-5 text-sm text-white/80">' + r.tips.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
        (r.better ? '<div class="mt-4 text-[11px] font-medium uppercase tracking-widest text-white/40">A better version</div><div class="mt-1.5">' + textBox(r.better) + actions(0) + '</div>' : '');
    } else if (r.tool === 'ideas') {
      body = '<div class="space-y-2">' + t.map(function (o, i) {
        var k = o.indexOf(' — '), head = k > 0 ? o.slice(0, k) : o, why = k > 0 ? o.slice(k + 3) : '';
        return '<div class="rounded-xl border border-white/10 bg-[#1a1a1f] p-3"><div class="text-sm font-medium text-white/90">' + esc(head) + '</div>' + (why ? '<div class="mt-0.5 text-xs text-white/50">' + esc(why) + '</div>' : '') +
          '<button type="button" class="btn btn-ghost btn-sm mt-2" data-act="write" data-i="' + i + '">Write this post</button></div>';
      }).join('') + '</div><p class="mt-3 text-xs text-white/40">Based on ' + (r.basedOn ? 'your ' + r.basedOn + ' ' + (r.measured ? 'best and latest' : 'latest') + ' posts and what is already in your queue.' : 'your focus: no posts to learn from yet.') + '</p>';
    } else {
      body = '<div class="space-y-3">' + t.map(function (o, i) { return '<div>' + textBox(o) + actions(i, '', r.tool === 'hook' || r.tool === 'cta') + '</div>'; }).join('') + '</div>';
      if (r.tool === 'winners') note = '<p class="mt-3 text-xs text-white/40">Based on your ' + (r.measured ? r.basedOn + ' best-performing posts.' : r.basedOn + ' latest posts (no results measured yet).') + '</p>' + note;
    }
    out(card(title, body + note));
  }

  function showError(title, msg) { out(card(title, '<p class="text-sm text-red-300">' + esc(msg) + '</p>')); }

  async function run() {
    if (S.busy) return;
    var tool = S.tool, text = $('aiInput').value.trim();
    if (!text && byId[tool].optional) text = 'my next posts';
    if (!text) { Vane.toast('info', byId[tool].hint); $('aiInput').focus(); return; }
    var n = networks();
    if (tool === 'reformat' && !n.length) { Vane.toast('info', 'Pick at least one channel under Channels first.'); return; }
    var body = { tool: tool, text: text, networks: n };
    if (tool === 'tone') body.tone = S.tone;
    if (tool === 'translate') body.lang = S.lang;
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
  function idsOf(platform) { return pickedChannels().filter(function (c) { return !platform || c.platform === platform; }).map(function (c) { return c.id; }); }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toLocal(ts) { var d = new Date(ts * 1000); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fromLocal(v) { var t = new Date(v).getTime(); return isNaN(t) ? 0 : Math.floor(t / 1000); }
  function zone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ''; } }

  async function openQueue(items, sameTime) {
    if (!pickedSet().size) { Vane.toast('info', 'Pick at least one channel under Channels first.'); return; }
    var r = await Vane.api('GET', '/api/ai/slots?count=' + (sameTime ? 1 : items.length));
    if (!r.ok) { Vane.toast('err', r.error); return; }
    S.queue = { personal: r.data.personal, items: items.map(function (it, i) { return { text: it.text, ids: it.ids, label: it.label, at: r.data.slots[sameTime ? 0 : i], on: true, error: '' }; }) };
    renderQueue();
  }

  function renderQueue(notice) {
    var q = S.queue, now = toLocal(Math.floor(Date.now() / 1000));
    var rows = q.items.map(function (it, i) {
      var chans = channels().filter(function (c) { return it.ids.indexOf(c.id) > -1; }).map(function (c) { return c.name; }).join(', ');
      return '<div class="rounded-xl border ' + (it.error ? 'border-red-400/40' : 'border-white/10') + ' bg-[#1a1a1f] p-3' + (it.on ? '' : ' opacity-50') + '">' +
        '<div class="flex flex-wrap items-center gap-2"><label class="flex items-center gap-2 text-xs text-white/60"><input type="checkbox" data-qon="' + i + '"' + (it.on ? ' checked' : '') + ' /> Send</label>' +
        '<input type="datetime-local" class="field !h-9 !w-auto !rounded-lg !px-2.5 !py-1 text-sm" data-qat="' + i + '" min="' + now + '" value="' + toLocal(it.at) + '" aria-label="Time for post ' + (i + 1) + '" />' +
        '<span class="min-w-0 truncate text-xs text-white/40">' + (it.label ? esc(it.label) + ' · ' : '') + esc(chans) + '</span></div>' +
        '<textarea rows="2" class="field mt-2 w-full resize-y !rounded-lg !p-2.5 text-sm" data-qtext="' + i + '" aria-label="Text of post ' + (i + 1) + '">' + esc(it.text) + '</textarea>' +
        (it.error ? '<p class="mt-1.5 text-xs text-red-300">' + esc(it.error) + '</p>' : '') + '</div>';
    }).join('');
    var count = q.items.filter(function (x) { return x.on; }).length;
    out(card('Your queue',
      '<p class="mb-3 text-xs leading-relaxed text-white/50">' + (q.personal ? 'Times come from when your posts did best, and skip what is already in your queue.' : 'Morning times for now: your own best times appear after a few measured posts.') + ' Change any time or text, untick what you do not want. Time zone: ' + esc(zone() || 'your device') + '.</p>' +
      (notice ? '<p class="mb-3 rounded-xl border border-amber-300/20 bg-amber-400/10 p-2.5 text-xs text-amber-200">' + esc(notice) + '</p>' : '') +
      '<div class="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-white/50"><span>Move all:</span>' +
        [['-1 day', -86400], ['-1 h', -3600], ['+1 h', 3600], ['+1 day', 86400]].map(function (b) { return '<button type="button" class="chip" data-shift="' + b[1] + '"><span>' + b[0] + '</span></button>'; }).join('') + '</div>' +
      '<div class="space-y-2">' + rows + '</div>' +
      '<div class="mt-4 flex flex-wrap gap-2"><button type="button" class="btn btn-white btn-sm" data-act="schedule"' + (count ? '' : ' disabled') + '>Schedule ' + count + ' post' + (count === 1 ? '' : 's') + '</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="back">Back</button></div>'));
  }

  async function schedule() {
    var q = S.queue;
    if (!q || S.busy) return;
    var now = Math.floor(Date.now() / 1000), todo = q.items.filter(function (x) { return x.on; }), bad = false;
    todo.forEach(function (x) { x.error = ''; if (!x.at || x.at < now + 30) { x.error = 'Pick a time in the future.'; bad = true; } if (!x.text.trim()) { x.error = 'The text is empty.'; bad = true; } });
    if (bad) { renderQueue(); return; }
    setBusy(true);
    var ok = 0, failed = 0;
    for (var i = 0; i < todo.length; i++) {
      var r = await Vane.api('POST', '/api/posts', { content: todo[i].text.trim(), channelIds: todo[i].ids, scheduledAt: todo[i].at });
      if (r.ok) { todo[i].done = true; ok++; } else { todo[i].error = r.error || 'Could not schedule this one.'; failed++; }
    }
    setBusy(false);
    if (ok) document.dispatchEvent(new CustomEvent('vane:scheduled'));
    if (!failed) {
      S.queue = null;
      out(card('Scheduled', '<p class="text-sm text-white/80">' + ok + ' post' + (ok === 1 ? ' is' : 's are') + ' in your queue. You can see and change them under Scheduled on the Create tab.</p>'));
      Vane.toast('ok', ok + ' scheduled.');
      return;
    }
    q.items = q.items.filter(function (x) { return !x.done; });
    renderQueue(ok + ' scheduled. ' + failed + ' did not go through: fix them below and try again.');
  }

  function useInEditor(text, platform) {
    Vane.composer.select(idsOf(platform));
    Vane.composer.set(text);
    location.hash = '#create';
  }

  function queueItemsFor(r) {
    var t = texts(r);
    if (r.tool === 'reformat') return { sameTime: true, items: r.variants.map(function (v) { return { text: v.text, ids: idsOf(v.platform), label: label(v.platform) }; }).filter(function (x) { return x.ids.length; }) };
    return { sameTime: false, items: t.map(function (x, i) { return { text: x, ids: idsOf(), label: r.tool === 'plan' ? DAYS[r.items[i].day] : '' }; }) };
  }

  root.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-tool]');
    if (t) { S.tool = t.getAttribute('data-tool'); renderTools(); return; }
    var tn = e.target.closest('[data-tone]');
    if (tn) { S.tone = tn.getAttribute('data-tone'); renderTools(); return; }
    var lg = e.target.closest('[data-lang]');
    if (lg) { S.lang = lg.getAttribute('data-lang'); renderTools(); return; }
    var ch = e.target.closest('[data-chan]');
    if (ch) { var id = ch.getAttribute('data-chan'); if (pickedSet().has(id)) S.picked.delete(id); else S.picked.add(id); renderChans(); return; }
    var sh = e.target.closest('[data-shift]');
    if (sh && S.queue) { S.queue.items.forEach(function (x) { if (x.on) x.at += Number(sh.getAttribute('data-shift')); }); renderQueue(); return; }
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
      var txt = pick(i), res = S.result;
      if (res.tool === 'hook') txt = txt + '\n\n' + Vane.composer.text();
      else if (res.tool === 'cta') txt = Vane.composer.text().replace(/\s+$/, '') + '\n\n' + txt;
      useInEditor(txt, res.tool === 'reformat' ? res.variants[i].platform : '');
    } else if (act === 'copy') {
      try { await navigator.clipboard.writeText(pick(i)); Vane.toast('ok', 'Copied.'); } catch (err) { Vane.toast('err', 'Could not copy.'); }
    } else if (act === 'write') {
      var o = pick(i), k = o.indexOf(' — ');
      S.tool = 'generate'; renderTools(); $('aiInput').value = k > 0 ? o.slice(0, k) : o; $('aiInput').focus();
      Vane.toast('info', 'Press Go to write it.');
    } else if (act === 'queue') { var qi = queueItemsFor(S.result); openQueue(qi.items, qi.sameTime); }
    else if (act === 'queue1') {
      var res2 = S.result, plat = res2.tool === 'reformat' ? res2.variants[i].platform : '';
      openQueue([{ text: pick(i), ids: idsOf(plat), label: plat ? label(plat) : '' }], false);
    }
    else if (act === 'schedule') schedule();
    else if (act === 'back') { S.queue = null; showResult(S.result); }
  });

  root.addEventListener('change', function (e) {
    var q = S.queue;
    if (!q) return;
    var on = e.target.closest('[data-qon]'), at = e.target.closest('[data-qat]');
    if (on) { q.items[Number(on.getAttribute('data-qon'))].on = on.checked; renderQueue(); }
    else if (at) { var it = q.items[Number(at.getAttribute('data-qat'))]; it.at = fromLocal(at.value); it.error = ''; }
  });
  root.addEventListener('input', function (e) {
    var tx = e.target.closest('[data-qtext]');
    if (tx && S.queue) { var it = S.queue.items[Number(tx.getAttribute('data-qtext'))]; it.text = tx.value; it.error = ''; }
  });

  $('aiInput').addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); });

  function waitForChannels(n) {
    if (channels().length || n > 8) { renderChans(); return; }
    setTimeout(function () { waitForChannels(n + 1); }, 600);
  }

  async function open() {
    renderTools();
    waitForChannels(0);
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

/* Vane for Obsidian: built from integrations/obsidian/src by `npm run build:obsidian`. Source: https://github.com/ULTRAAAA3000/vaneapp */
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// integrations/obsidian/src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => VanePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// integrations/obsidian/src/api.ts
var VaneError = class extends Error {
  constructor(message, status, code = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "VaneError";
  }
};
var DEFAULT_BASE = "https://vaneapp.dev";
function cleanBase(raw) {
  const t = raw.trim().replace(/\/+$/, "");
  let u;
  try {
    u = new URL(t);
  } catch (e) {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    return null;
  if (u.username || u.password || u.search || u.hash)
    return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}
function keyProblem(key) {
  const k = key.trim();
  if (!k)
    return "Paste your Vane API key in the plugin settings first.";
  if (!/^cpost_(live|test)_[A-Za-z0-9_-]{8,}$/.test(k))
    return "That does not look like a Vane Post API key (it starts with cpost_live_ or cpost_test_).";
  return null;
}
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function fail(res) {
  const body = isRecord(res.json) ? res.json : {};
  const text = typeof body.error === "string" ? body.error : "";
  const code = typeof body.code === "string" ? body.code : null;
  if (res.status === 401)
    return new VaneError("Vane did not accept the API key. Check it in the plugin settings (it may have been revoked).", 401, code);
  if (res.status === 402 || code === "quota_exceeded")
    return new VaneError(text || "Your plan has no API posts left this month.", 402, code != null ? code : "quota_exceeded");
  if (res.status === 429)
    return new VaneError("Too many requests. Wait a minute and try again.", 429, code);
  return new VaneError(text || `Vane answered with an error (${res.status}).`, res.status, code);
}
var headers = (key) => ({ Authorization: `Bearer ${key.trim()}`, "Content-Type": "application/json" });
async function listChannels(http2, base, key) {
  const res = await http2({ url: `${base}/api/v1/channels`, method: "GET", headers: headers(key) });
  if (res.status !== 200 || !isRecord(res.json) || !Array.isArray(res.json.channels))
    throw fail(res);
  return res.json.channels.filter(isRecord).filter((c) => typeof c.id === "string" && typeof c.platform === "string").map((c) => ({ id: c.id, platform: c.platform, name: typeof c.name === "string" ? c.name : c.platform, isActive: c.isActive !== false }));
}
async function createPost(http2, base, key, post, idempotencyKey) {
  const res = await http2({
    url: `${base}/api/v1/posts`,
    method: "POST",
    headers: { ...headers(key), "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ content: post.content, channelIds: post.channelIds, scheduledAt: post.scheduledAt })
  });
  if (res.status !== 201 && res.status !== 200 || !isRecord(res.json) || res.json.ok !== true)
    throw fail(res);
  const j = res.json;
  return {
    groupId: typeof j.groupId === "string" ? j.groupId : "",
    scheduledAt: typeof j.scheduledAt === "number" ? j.scheduledAt : 0,
    channels: Array.isArray(j.posts) ? j.posts.length : post.channelIds.length,
    test: j.test === true
  };
}
var SOON_SECONDS = 90;
function whenToIso(mode, local, nowMs) {
  if (mode === "soon")
    return { iso: new Date(nowMs + SOON_SECONDS * 1e3).toISOString() };
  const at = new Date(local);
  if (!local || Number.isNaN(at.getTime()))
    return { error: "Pick the date and time to post at." };
  if (at.getTime() <= nowMs + 6e4)
    return { error: "Pick a time at least a minute from now." };
  if (at.getTime() > nowMs + 365 * 864e5)
    return { error: "Vane schedules at most one year ahead." };
  return { iso: at.toISOString() };
}

// integrations/obsidian/src/convert.ts
var DEFAULT_CONVERT = { stripFrontmatter: true, plainText: true };
var FRONTMATTER = /^\uFEFF?---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/;
function noteToPost(markdown, options = DEFAULT_CONVERT) {
  let t = markdown.replace(/\r\n?/g, "\n");
  if (options.stripFrontmatter)
    t = t.replace(FRONTMATTER, "");
  t = t.replace(/%%[\s\S]*?%%/g, "").replace(/<!--[\s\S]*?-->/g, "");
  if (options.plainText) {
    const code = [];
    t = t.replace(/^(```|~~~)[^\n]*\n([\s\S]*?)\n?\1[ \t]*$/gm, (_m, _f, body) => {
      code.push(body);
      return `\0${code.length - 1}\0`;
    });
    t = t.replace(/`([^`\n]+)`/g, (_m, body) => {
      code.push(body);
      return `\0${code.length - 1}\0`;
    });
    t = t.replace(/!\[\[[^\]]*\]\]/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, (_m, _page, alias) => alias).replace(/\[\[([^\]#|^]*)(?:[#^][^\]|]*)?\]\]/g, (_m, page) => page.trim()).replace(/\[([^\]]+)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (_m, text, url) => /^https?:\/\//i.test(url) ? text.trim() === url ? url : `${text} (${url})` : text).replace(/^[ \t]*\[\^[^\]]+\]:.*$/gm, "").replace(/\[\^[^\]]+\]/g, "").replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, "").replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm, "$1").replace(/^[ \t]*>[ \t]*\[![^\]]*\][+-]?[ \t]*/gm, "> ").replace(/^[ \t]*(?:>[ \t]?)+/gm, "").replace(/^([ \t]*)[-*+][ \t]+\[[xX]\][ \t]+/gm, "$1\u2713 ").replace(/^([ \t]*)[-*+][ \t]+\[ \][ \t]+/gm, "$1\u2022 ").replace(/^([ \t]*)[-*+][ \t]+/gm, "$1\u2022 ").replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2").replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1").replace(/==(?=\S)([\s\S]*?\S)==/g, "$1").replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*[^\s*])\*(?![\w*])/gm, "$1$2").replace(/(^|[^\w_])_(?=[^\s_])([^_\n]*[^\s_])_(?![\w_])/gm, "$1$2").replace(/[ \t]+\^[A-Za-z0-9-]+[ \t]*$/gm, "");
    t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => {
      var _a;
      return (_a = code[Number(i)]) != null ? _a : "";
    });
  }
  return t.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// integrations/obsidian/src/main.ts
var DEFAULTS = { baseUrl: DEFAULT_BASE, apiKey: "", stripFrontmatter: DEFAULT_CONVERT.stripFrontmatter, plainText: DEFAULT_CONVERT.plainText, channelIds: [], channels: [] };
var http = async (req) => {
  const res = await (0, import_obsidian.requestUrl)({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
  let json = null;
  try {
    json = res.json;
  } catch (e) {
  }
  return { status: res.status, json };
};
var PLATFORM_NAMES = { telegram: "Telegram", x: "X", twitter: "X", linkedin: "LinkedIn", bluesky: "Bluesky", mastodon: "Mastodon", threads: "Threads", reddit: "Reddit", facebook: "Facebook" };
var channelLabel = (c) => {
  var _a;
  return `${(_a = PLATFORM_NAMES[c.platform]) != null ? _a : c.platform}: ${c.name}`;
};
var VanePlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULTS };
  }
  async onload() {
    this.settings = { ...DEFAULTS, ...await this.loadData() };
    this.addRibbonIcon("send", "Post to Vane", () => this.postFromActiveNote());
    this.addCommand({ id: "post-note", name: "Post note to Vane", callback: () => this.postFromActiveNote() });
    this.addCommand({
      id: "post-selection",
      name: "Post selection to Vane",
      editorCheckCallback: (checking, editor) => {
        if (!editor.getSelection())
          return false;
        if (!checking)
          this.open(editor.getSelection());
        return true;
      }
    });
    this.addCommand({ id: "reload-channels", name: "Reload Vane channels", callback: () => {
      void this.reloadChannels(true);
    } });
    this.addSettingTab(new VaneSettingTab(this.app, this));
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  /** The whole note in the editor (the selection has its own command). */
  postFromActiveNote() {
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view) {
      new import_obsidian.Notice("Open a note first, then run this command again.");
      return;
    }
    this.open(view.editor.getValue());
  }
  open(markdown) {
    const problem = keyProblem(this.settings.apiKey);
    if (problem) {
      new import_obsidian.Notice(`Vane: ${problem}`);
      return;
    }
    if (!cleanBase(this.settings.baseUrl)) {
      new import_obsidian.Notice("Vane: the address in the plugin settings is not valid.");
      return;
    }
    const text = noteToPost(markdown, { stripFrontmatter: this.settings.stripFrontmatter, plainText: this.settings.plainText });
    if (!text) {
      new import_obsidian.Notice("Vane: there is no text to post (the note is empty).");
      return;
    }
    new PostModal(this.app, this, text).open();
  }
  /** Reads the channels from Vane and keeps them. Returns the list (the old one when Vane cannot be reached). */
  async reloadChannels(announce) {
    const base = cleanBase(this.settings.baseUrl);
    const problem = keyProblem(this.settings.apiKey);
    if (!base || problem) {
      if (announce)
        new import_obsidian.Notice(`Vane: ${problem != null ? problem : "the address is not valid."}`);
      return this.settings.channels;
    }
    try {
      const list = (await listChannels(http, base, this.settings.apiKey)).filter((c) => c.isActive);
      this.settings.channels = list;
      this.settings.channelIds = this.settings.channelIds.filter((id) => list.some((c) => c.id === id));
      await this.saveSettings();
      if (announce)
        new import_obsidian.Notice(list.length ? `Vane: ${list.length} channel${list.length === 1 ? "" : "s"} loaded.` : "Vane: no channels yet. Connect one in the Vane dashboard.");
    } catch (err) {
      if (announce)
        new import_obsidian.Notice(`Vane: ${err instanceof VaneError ? err.message : "could not reach Vane."}`);
    }
    return this.settings.channels;
  }
  async send(content, channelIds, scheduledAt) {
    const base = cleanBase(this.settings.baseUrl);
    if (!base)
      throw new VaneError("The address in the plugin settings is not valid.", 0);
    const r = await createPost(http, base, this.settings.apiKey, { content, channelIds, scheduledAt }, crypto.randomUUID());
    return { test: r.test, channels: r.channels, at: r.scheduledAt ? new Date(r.scheduledAt * 1e3) : new Date(scheduledAt) };
  }
};
var PostModal = class extends import_obsidian.Modal {
  constructor(app, plugin, text) {
    super(app);
    this.plugin = plugin;
    this.mode = "soon";
    this.local = "";
    this.busy = false;
    this.text = text;
    this.chosen = new Set(plugin.settings.channelIds);
  }
  onOpen() {
    this.modalEl.addClass("vane-modal");
    this.render();
    void this.plugin.reloadChannels(false).then((list) => {
      if (list.length) {
        this.chosen = new Set([...this.chosen].filter((id) => list.some((c) => c.id === id)));
        this.render();
      }
    });
  }
  onClose() {
    this.contentEl.empty();
  }
  render(error = "") {
    const el = this.contentEl;
    el.empty();
    el.createEl("h3", { text: "Post to Vane" });
    const box = el.createEl("textarea", { attr: { rows: "8", "aria-label": "Post text" } });
    box.value = this.text;
    const count = el.createDiv({ cls: "vane-count", text: `${this.text.length} characters` });
    box.addEventListener("input", () => {
      this.text = box.value;
      count.setText(`${this.text.length} characters`);
    });
    el.createDiv({ cls: "vane-label", text: "Channels" });
    const channels = this.plugin.settings.channels;
    if (!channels.length) {
      el.createDiv({ cls: "vane-hint", text: "No channels yet. Connect one in the Vane dashboard, then run \u201CReload Vane channels\u201D." });
    } else {
      const row = el.createDiv({ cls: "vane-channels" });
      for (const c of channels) {
        const chip = row.createEl("label", { cls: `vane-chip${this.chosen.has(c.id) ? " is-on" : ""}` });
        const input = chip.createEl("input", { attr: { type: "checkbox" } });
        input.checked = this.chosen.has(c.id);
        chip.createSpan({ text: channelLabel(c) });
        input.addEventListener("change", () => {
          if (input.checked)
            this.chosen.add(c.id);
          else
            this.chosen.delete(c.id);
          chip.toggleClass("is-on", input.checked);
        });
      }
    }
    el.createDiv({ cls: "vane-label", text: "When" });
    const when = el.createDiv({ cls: "vane-when" });
    const select = when.createEl("select");
    select.createEl("option", { text: "As soon as possible", value: "soon" });
    select.createEl("option", { text: "At a chosen time", value: "at" });
    select.value = this.mode;
    const picker = when.createEl("input", { attr: { type: "datetime-local" } });
    picker.value = this.local;
    picker.toggle(this.mode === "at");
    select.addEventListener("change", () => {
      this.mode = select.value === "at" ? "at" : "soon";
      picker.toggle(this.mode === "at");
    });
    picker.addEventListener("input", () => {
      this.local = picker.value;
    });
    const hint = el.createDiv({ cls: "vane-hint" });
    const hintText = () => this.mode === "soon" ? "Vane sends it within a minute or two." : "Your local time.";
    hint.setText(hintText());
    select.addEventListener("change", () => hint.setText(hintText()));
    if (error)
      el.createDiv({ cls: "vane-error", text: error });
    const actions = el.createDiv({ cls: "vane-actions" });
    new import_obsidian.Setting(actions).setClass("vane-actions-setting").addButton((b) => b.setButtonText("Cancel").onClick(() => this.close())).addButton((b) => b.setButtonText(this.mode === "soon" ? "Post" : "Schedule").setCta().setDisabled(this.busy).onClick(() => {
      void this.submit();
    }));
  }
  async submit() {
    if (this.busy)
      return;
    const content = this.text.trim();
    if (!content) {
      this.render("Write something to post.");
      return;
    }
    if (!this.chosen.size) {
      this.render("Tick at least one channel.");
      return;
    }
    const when = whenToIso(this.mode, this.local, Date.now());
    if ("error" in when) {
      this.render(when.error);
      return;
    }
    this.busy = true;
    try {
      const r = await this.plugin.send(content, [...this.chosen], when.iso);
      this.plugin.settings.channelIds = [...this.chosen];
      await this.plugin.saveSettings();
      const where = `${r.channels} channel${r.channels === 1 ? "" : "s"}`;
      new import_obsidian.Notice(r.test ? `Vane TEST MODE: checked for ${where}, nothing was posted.` : `Vane: scheduled for ${where}, ${r.at.toLocaleString()}.`, 7e3);
      this.close();
    } catch (err) {
      this.busy = false;
      this.render(err instanceof VaneError ? err.message : "Could not reach Vane. Check your connection and try again.");
    }
  }
};
var VaneSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    new import_obsidian.Setting(containerEl).setName("Vane API key").setDesc("Create one in the Vane dashboard under API keys (choose \u201CObsidian\u201D in \u201CUsed with\u201D). A test key (cpost_test_\u2026) checks everything and posts nothing.").addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder("cpost_live_\u2026").setValue(s.apiKey).onChange(async (v) => {
        s.apiKey = v.trim();
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Vane address").setDesc("Leave as it is unless you run your own Vane.").addText((t) => t.setPlaceholder(DEFAULT_BASE).setValue(s.baseUrl).onChange(async (v) => {
      s.baseUrl = v.trim() || DEFAULT_BASE;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Channels").setDesc(s.channels.length ? s.channels.map(channelLabel).join(", ") : "Not loaded yet.").addButton((b) => b.setButtonText("Load channels").onClick(async () => {
      await this.plugin.reloadChannels(true);
      this.display();
    }));
    new import_obsidian.Setting(containerEl).setName("Remove properties").setDesc("Do not post the properties block at the top of a note.").addToggle((t) => t.setValue(s.stripFrontmatter).onChange(async (v) => {
      s.stripFrontmatter = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Turn Markdown into plain text").setDesc("Removes **bold**, headings and [[wikilinks]] markers, writes links out in full. Hashtags stay. You can still edit the text before sending.").addToggle((t) => t.setValue(s.plainText).onChange(async (v) => {
      s.plainText = v;
      await this.plugin.saveSettings();
    }));
  }
};

/**
 * Vane for Obsidian: post or schedule the open note (or the selected text) to the channels connected in Vane.
 * Commands: "Post note to Vane", "Post selection to Vane", "Reload Vane channels". The text goes through noteToPost() first, so
 * Markdown does not reach the networks as noise; it can still be edited in the window before sending.
 */
import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import { cleanBase, createPost, DEFAULT_BASE, keyProblem, listChannels, VaneError, whenToIso, type Channel, type Http } from './api';
import { DEFAULT_CONVERT, noteToPost } from './convert';

interface VaneSettings {
  baseUrl: string;
  apiKey: string;
  stripFrontmatter: boolean;
  plainText: boolean;
  /** Channels ticked by default in the window. */
  channelIds: string[];
  /** The last list read from Vane, so the window opens at once. */
  channels: Channel[];
}

const DEFAULTS: VaneSettings = { baseUrl: DEFAULT_BASE, apiKey: '', stripFrontmatter: DEFAULT_CONVERT.stripFrontmatter, plainText: DEFAULT_CONVERT.plainText, channelIds: [], channels: [] };

/** Obsidian's own request function (no browser CORS rules). A body that is not JSON comes back as null. */
const http: Http = async (req) => {
  const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
  let json: unknown = null;
  try { json = res.json; } catch { /* not JSON */ }
  return { status: res.status, json };
};

const PLATFORM_NAMES: Record<string, string> = { telegram: 'Telegram', x: 'X', twitter: 'X', linkedin: 'LinkedIn', bluesky: 'Bluesky', mastodon: 'Mastodon', threads: 'Threads', reddit: 'Reddit', facebook: 'Facebook' };
const channelLabel = (c: Channel): string => `${PLATFORM_NAMES[c.platform] ?? c.platform}: ${c.name}`;

export default class VanePlugin extends Plugin {
  settings: VaneSettings = { ...DEFAULTS };

  async onload(): Promise<void> {
    this.settings = { ...DEFAULTS, ...(await this.loadData() as Partial<VaneSettings> | null) };

    this.addRibbonIcon('send', 'Post to Vane', () => this.postFromActiveNote());
    this.addCommand({ id: 'post-note', name: 'Post note to Vane', callback: () => this.postFromActiveNote() });
    this.addCommand({
      id: 'post-selection', name: 'Post selection to Vane',
      editorCheckCallback: (checking: boolean, editor: Editor) => {
        if (!editor.getSelection()) return false;
        if (!checking) this.open(editor.getSelection());
        return true;
      },
    });
    this.addCommand({ id: 'reload-channels', name: 'Reload Vane channels', callback: () => { void this.reloadChannels(true); } });
    this.addSettingTab(new VaneSettingTab(this.app, this));
  }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  /** The whole note in the editor (the selection has its own command). */
  private postFromActiveNote(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { new Notice('Open a note first, then run this command again.'); return; }
    this.open(view.editor.getValue());
  }

  private open(markdown: string): void {
    const problem = keyProblem(this.settings.apiKey);
    if (problem) { new Notice(`Vane: ${problem}`); return; }
    if (!cleanBase(this.settings.baseUrl)) { new Notice('Vane: the address in the plugin settings is not valid.'); return; }
    const text = noteToPost(markdown, { stripFrontmatter: this.settings.stripFrontmatter, plainText: this.settings.plainText });
    if (!text) { new Notice('Vane: there is no text to post (the note is empty).'); return; }
    new PostModal(this.app, this, text).open();
  }

  /** Reads the channels from Vane and keeps them. Returns the list (the old one when Vane cannot be reached). */
  async reloadChannels(announce: boolean): Promise<Channel[]> {
    const base = cleanBase(this.settings.baseUrl);
    const problem = keyProblem(this.settings.apiKey);
    if (!base || problem) { if (announce) new Notice(`Vane: ${problem ?? 'the address is not valid.'}`); return this.settings.channels; }
    try {
      const list = (await listChannels(http, base, this.settings.apiKey)).filter((c) => c.isActive);
      this.settings.channels = list;
      this.settings.channelIds = this.settings.channelIds.filter((id) => list.some((c) => c.id === id));
      await this.saveSettings();
      if (announce) new Notice(list.length ? `Vane: ${list.length} channel${list.length === 1 ? '' : 's'} loaded.` : 'Vane: no channels yet. Connect one in the Vane dashboard.');
    } catch (err) {
      if (announce) new Notice(`Vane: ${err instanceof VaneError ? err.message : 'could not reach Vane.'}`);
    }
    return this.settings.channels;
  }

  async send(content: string, channelIds: string[], scheduledAt: string): Promise<{ test: boolean; channels: number; at: Date }> {
    const base = cleanBase(this.settings.baseUrl);
    if (!base) throw new VaneError('The address in the plugin settings is not valid.', 0);
    const r = await createPost(http, base, this.settings.apiKey, { content, channelIds, scheduledAt }, crypto.randomUUID());
    return { test: r.test, channels: r.channels, at: r.scheduledAt ? new Date(r.scheduledAt * 1000) : new Date(scheduledAt) };
  }
}

class PostModal extends Modal {
  private chosen: Set<string>;
  private mode: 'soon' | 'at' = 'soon';
  private local = '';
  private text: string;
  private busy = false;

  constructor(app: App, private readonly plugin: VanePlugin, text: string) {
    super(app);
    this.text = text;
    this.chosen = new Set(plugin.settings.channelIds);
  }

  onOpen(): void {
    this.modalEl.addClass('vane-modal');
    this.render();
    // Refresh the list in the background: the window already shows the last one.
    void this.plugin.reloadChannels(false).then((list) => { if (list.length) { this.chosen = new Set([...this.chosen].filter((id) => list.some((c) => c.id === id))); this.render(); } });
  }

  onClose(): void { this.contentEl.empty(); }

  private render(error = ''): void {
    const el = this.contentEl;
    el.empty();
    el.createEl('h3', { text: 'Post to Vane' });

    const box = el.createEl('textarea', { attr: { rows: '8', 'aria-label': 'Post text' } });
    box.value = this.text;
    const count = el.createDiv({ cls: 'vane-count', text: `${this.text.length} characters` });
    box.addEventListener('input', () => { this.text = box.value; count.setText(`${this.text.length} characters`); });

    el.createDiv({ cls: 'vane-label', text: 'Channels' });
    const channels = this.plugin.settings.channels;
    if (!channels.length) {
      el.createDiv({ cls: 'vane-hint', text: 'No channels yet. Connect one in the Vane dashboard, then run “Reload Vane channels”.' });
    } else {
      const row = el.createDiv({ cls: 'vane-channels' });
      for (const c of channels) {
        const chip = row.createEl('label', { cls: `vane-chip${this.chosen.has(c.id) ? ' is-on' : ''}` });
        const input = chip.createEl('input', { attr: { type: 'checkbox' } });
        input.checked = this.chosen.has(c.id);
        chip.createSpan({ text: channelLabel(c) });
        input.addEventListener('change', () => { if (input.checked) this.chosen.add(c.id); else this.chosen.delete(c.id); chip.toggleClass('is-on', input.checked); });
      }
    }

    el.createDiv({ cls: 'vane-label', text: 'When' });
    const when = el.createDiv({ cls: 'vane-when' });
    const select = when.createEl('select');
    select.createEl('option', { text: 'As soon as possible', value: 'soon' });
    select.createEl('option', { text: 'At a chosen time', value: 'at' });
    select.value = this.mode;
    const picker = when.createEl('input', { attr: { type: 'datetime-local' } });
    picker.value = this.local;
    picker.toggle(this.mode === 'at');
    select.addEventListener('change', () => { this.mode = select.value === 'at' ? 'at' : 'soon'; picker.toggle(this.mode === 'at'); });
    picker.addEventListener('input', () => { this.local = picker.value; });
    const hint = el.createDiv({ cls: 'vane-hint' });
    const hintText = (): string => (this.mode === 'soon' ? 'Vane sends it within a minute or two.' : 'Your local time.');
    hint.setText(hintText());
    select.addEventListener('change', () => hint.setText(hintText()));

    if (error) el.createDiv({ cls: 'vane-error', text: error });

    const actions = el.createDiv({ cls: 'vane-actions' });
    new Setting(actions).setClass('vane-actions-setting')
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.mode === 'soon' ? 'Post' : 'Schedule').setCta().setDisabled(this.busy).onClick(() => { void this.submit(); }));
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const content = this.text.trim();
    if (!content) { this.render('Write something to post.'); return; }
    if (!this.chosen.size) { this.render('Tick at least one channel.'); return; }
    const when = whenToIso(this.mode, this.local, Date.now());
    if ('error' in when) { this.render(when.error); return; }
    this.busy = true;
    try {
      const r = await this.plugin.send(content, [...this.chosen], when.iso);
      this.plugin.settings.channelIds = [...this.chosen];
      await this.plugin.saveSettings();
      const where = `${r.channels} channel${r.channels === 1 ? '' : 's'}`;
      new Notice(r.test ? `Vane TEST MODE: checked for ${where}, nothing was posted.` : `Vane: scheduled for ${where}, ${r.at.toLocaleString()}.`, 7000);
      this.close();
    } catch (err) {
      this.busy = false;
      this.render(err instanceof VaneError ? err.message : 'Could not reach Vane. Check your connection and try again.');
    }
  }
}

class VaneSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: VanePlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl).setName('Vane API key')
      .setDesc('Create one in the Vane dashboard under API keys (choose “Obsidian” in “Used with”). A test key (cpost_test_…) checks everything and posts nothing.')
      .addText((t) => { t.inputEl.type = 'password'; t.setPlaceholder('cpost_live_…').setValue(s.apiKey).onChange(async (v) => { s.apiKey = v.trim(); await this.plugin.saveSettings(); }); });

    new Setting(containerEl).setName('Vane address').setDesc('Leave as it is unless you run your own Vane.')
      .addText((t) => t.setPlaceholder(DEFAULT_BASE).setValue(s.baseUrl).onChange(async (v) => { s.baseUrl = v.trim() || DEFAULT_BASE; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Channels').setDesc(s.channels.length ? s.channels.map(channelLabel).join(', ') : 'Not loaded yet.')
      .addButton((b) => b.setButtonText('Load channels').onClick(async () => { await this.plugin.reloadChannels(true); this.display(); }));

    new Setting(containerEl).setName('Remove properties').setDesc('Do not post the properties block at the top of a note.')
      .addToggle((t) => t.setValue(s.stripFrontmatter).onChange(async (v) => { s.stripFrontmatter = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Turn Markdown into plain text').setDesc('Removes **bold**, headings and [[wikilinks]] markers, writes links out in full. Hashtags stay. You can still edit the text before sending.')
      .addToggle((t) => t.setValue(s.plainText).onChange(async (v) => { s.plainText = v; await this.plugin.saveSettings(); }));
  }
}

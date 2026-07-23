import {
	App,
	ItemView,
	Modal,
	Notice,
	Plugin,
	Scope,
	TFile,
	TFolder,
	WorkspaceLeaf,
	normalizePath,
} from "obsidian";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { vim, Vim, getCM } from "@replit/codemirror-vim";

const OIL_VIEW_TYPE = "oil-explorer-view";

/** A single planned filesystem operation, computed by diffing the buffer against the original listing. */
type Op =
	| { type: "rename"; from: string; to: string }
	| { type: "create"; name: string }
	| { type: "delete"; name: string };

function stripSlash(name: string): string {
	return name.endsWith("/") ? name.slice(0, -1) : name;
}

function isDirEntry(name: string): boolean {
	return name.endsWith("/");
}

/** Simple yes/cancel confirmation modal, used before destructive delete operations. */
function confirmModal(app: App, message: string, confirmLabel = "Confirm"): Promise<boolean> {
	return new Promise((resolve) => {
		class ConfirmModal extends Modal {
			onOpen() {
				const { contentEl } = this;
				contentEl.createEl("p", { text: message });
				const row = contentEl.createDiv({ cls: "oil-confirm-buttons" });
				const yes = row.createEl("button", { text: confirmLabel, cls: "mod-warning" });
				yes.addEventListener("click", () => {
					resolve(true);
					this.close();
				});
				const no = row.createEl("button", { text: "Cancel" });
				no.addEventListener("click", () => {
					resolve(false);
					this.close();
				});
				// While CodeMirror still had DOM focus, raw keydowns (Enter
				// included) were reaching Vim directly regardless of this
				// modal being visually on top. Explicitly moving focus here
				// makes the browser's own native button-activation handle
				// Enter/Space.
				window.setTimeout(() => yes.focus(), 0);
			}
			onClose() {
				this.contentEl.empty();
			}
		}
		new ConfirmModal(app).open();
	});
}

/** How the Oil view decides whether to enable Vim keybindings. */
export type VimPreference = "auto" | "on" | "off";

class OilView extends ItemView {
	currentPath = "";
	originalNames: string[] = [];
	pathHeaderEl!: HTMLElement;
	hintEl!: HTMLElement;
	editorHostEl!: HTMLElement;
	editorView!: EditorView;
	plugin: OilExplorerPlugin;
	private oilScope!: Scope;
	private oilScopePushed = false;

	constructor(leaf: WorkspaceLeaf, plugin: OilExplorerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return OIL_VIEW_TYPE;
	}

	getDisplayText(): string {
		return `Oil: /${this.currentPath}`;
	}

	getIcon(): string {
		return "folder-open";
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("oil-view-container");

		this.pathHeaderEl = container.createDiv({ cls: "oil-path-header" });
		this.hintEl = container.createDiv({ cls: "oil-hint" });
		this.editorHostEl = container.createDiv({ cls: "oil-editor-host" });

		// Obsidian resolves hotkeys through its own Scope stack, which sits
		// entirely outside normal DOM event bubbling — that's why merely
		// calling stopPropagation() on our own elements didn't help before.
		// While this view's editor has focus, push a child scope that
		// swallows plain Escape so Obsidian's default Escape behavior
		// (which was kicking focus out of this tab) never runs.
		// CodeMirror-vim still sees the raw keydown independently and keeps
		// handling Insert → Normal mode on its own.
		this.oilScope = new Scope(this.app.scope);
		this.oilScope.register(null, "Escape", () => {
			// Our Scope handler runs through Obsidian's own keymap dispatch,
			// which — unlike ordinary DOM listeners — stops the native
			// keydown from ever reaching CodeMirror once we consume it here.
			// So Vim's Insert → Normal transition would never fire on its
			// own; we have to poke Vim's key handler manually instead.
			const cm = getCM(this.editorView);
			if (cm) {
				Vim.handleKey(cm, "<Esc>", "user");
			}
			return false;
		});

		this.registerDomEvent(this.editorHostEl, "focusin", () => {
			if (!this.oilScopePushed) {
				this.app.keymap.pushScope(this.oilScope);
				this.oilScopePushed = true;
			}
		});
		this.registerDomEvent(this.editorHostEl, "focusout", () => {
			if (this.oilScopePushed) {
				this.app.keymap.popScope(this.oilScope);
				this.oilScopePushed = false;
			}
		});

		this.buildEditor("");
		await this.setPath(this.currentPath);
	}

	/** Is Vim mode currently active for this view, given the plugin's preference? */
	private isVimActive(): boolean {
		const pref = this.plugin.vimPreference;
		if (pref === "on") return true;
		if (pref === "off") return false;
		// "auto": mirror Obsidian's own "Vim key bindings" editor setting.
		try {
			return !!(this.app.vault as unknown as { getConfig: (k: string) => unknown }).getConfig(
				"vimMode"
			);
		} catch {
			return false;
		}
	}

	/** (Re)builds the CodeMirror instance, e.g. after the Vim preference changes. */
	buildEditor(initialDoc: string) {
		const vimActive = this.isVimActive();

		if (this.editorView) {
			this.editorView.destroy();
		}

		const saveAndOpenKeymap = Prec.highest(
			keymap.of([
				{
					key: "Mod-s",
					preventDefault: true,
					run: () => {
						void this.applyChanges();
						return true;
					},
				},
				{
					key: "Mod-Enter",
					preventDefault: true,
					run: (view) => {
						void this.openEntryAtCursor(view);
						return true;
					},
				},
				{
					// Mirrors oil.nvim: "-" on an empty line jumps to the parent folder.
					// Only intercepted when the current line is blank, so normal Vim
					// motions that use "-" keep working everywhere else.
					key: "-",
					run: (view) => {
						const line = view.state.doc.lineAt(view.state.selection.main.head);
						if (line.text.trim() === "") {
							this.goUp();
							return true;
						}
						return false;
					},
				},
			])
		);

		const extensions = [
			...(vimActive ? [vim()] : []),
			saveAndOpenKeymap,
			keymap.of([...defaultKeymap, ...historyKeymap]),
			history(),
			EditorView.lineWrapping,
			EditorView.theme({
				"&": { height: "100%", fontSize: "0.95em" },
				".cm-content": { fontFamily: "var(--font-monospace)", padding: "10px" },
				".cm-scroller": { overflow: "auto" },
				"&.cm-focused": { outline: "none" },
			}),
		];

		this.editorHostEl.empty();
		this.editorView = new EditorView({
			state: EditorState.create({ doc: initialDoc, extensions }),
			parent: this.editorHostEl,
		});

		if (vimActive) {
			// ":w" saves the buffer, matching oil.nvim's normal save workflow.
			Vim.defineEx("write", "w", () => {
				void this.applyChanges();
			});
		}

		if (vimActive) {
			// ":w" saves the buffer, matching oil.nvim's normal save workflow.
			Vim.defineEx("write", "w", () => {
				void this.applyChanges();
			});

			// Vim's Normal/Visual mode key handling is entirely internal to the
			// vim extension — it does NOT fall through to CodeMirror's regular
			// keymap facet (that only happens in Insert mode). So to make "-"
			// and Enter work while in Normal mode, they must be registered
			// through Vim's own mapping API, exactly like oil.nvim does.
			Vim.defineEx("oilup", "oilup", () => {
				this.goUp();
			});
			Vim.defineEx("oilopen", "oilopen", () => {
				void this.openEntryAtCursor(this.editorView);
			});

			Vim.map("-", ":oilup<CR>", "normal");
			Vim.map("<CR>", ":oilopen<CR>", "normal");
			Vim.map("<C-s>", ":w<CR>", "normal");
			Vim.map("<C-s>", "<Esc>:w<CR>", "insert");
		}

		this.hintEl.setText(
			vimActive
				? "[Normal] -: 親フォルダへ / Enter: 開く / Ctrl+S・:w: 保存"
				: "Ctrl/Cmd+Enter: 開く・フォルダへ移動  |  空行で -: 親フォルダへ  |  Ctrl/Cmd+S: 変更を保存"
		);
	}

	async setPath(path: string) {
		const normalized = path ? normalizePath(path) : "";
		const folder =
			normalized === "" ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(normalized);

		if (!(folder instanceof TFolder)) {
			new Notice(`フォルダではありません: /${normalized}`);
			return;
		}

		this.currentPath = normalized;

		const children = [...folder.children].sort((a, b) => {
			const aDir = a instanceof TFolder;
			const bDir = b instanceof TFolder;
			if (aDir !== bDir) return aDir ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		this.originalNames = children.map((c) => (c instanceof TFolder ? c.name + "/" : c.name));
		const text = this.originalNames.join("\n") + (this.originalNames.length ? "\n" : "");

		this.editorView.dispatch({
			changes: { from: 0, to: this.editorView.state.doc.length, insert: text },
		});
		this.pathHeaderEl.setText(`/${this.currentPath}`);
		this.editorView.focus();
	}

	private goUp() {
		if (!this.currentPath) return;
		const parts = this.currentPath.split("/");
		parts.pop();
		void this.setPath(parts.join("/"));
	}

	private async openEntryAtCursor(view: EditorView) {
		const line = view.state.doc.lineAt(view.state.selection.main.head);
		const raw = line.text.trim();
		if (!raw) return;

		const dir = isDirEntry(raw);
		const name = stripSlash(raw);
		const fullPath = this.currentPath ? `${this.currentPath}/${name}` : name;
		const af = this.app.vault.getAbstractFileByPath(fullPath);

		if (dir) {
			await this.setPath(fullPath);
		} else if (af instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(af);
		} else {
			new Notice(`"${name}" は未保存です。先に Ctrl/Cmd+S（または :w）で保存してください。`);
		}
	}

	private async applyChanges() {
		const lines = this.editorView.state.doc
			.toString()
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);

		const seen = new Set<string>();
		for (const l of lines) {
			if (seen.has(l)) {
				new Notice(`重複した項目があります: ${l}`);
				return;
			}
			seen.add(l);
		}

		const original = this.originalNames;
		const origSet = new Set(original);
		const newSet = new Set(lines);
		const ops: Op[] = [];

		if (original.length === lines.length) {
			// 行数が変わっていない場合は位置ベースでリネームとして扱う（oil.nvimの挙動に近い）
			for (let i = 0; i < original.length; i++) {
				if (original[i] !== lines[i]) {
					if (isDirEntry(original[i]) !== isDirEntry(lines[i])) {
						new Notice(
							`"${original[i]}" の種別（ファイル/フォルダ）は変更できません。削除して作り直してください。`
						);
						return;
					}
					ops.push({ type: "rename", from: original[i], to: lines[i] });
				}
			}
		} else {
			for (const o of original) if (!newSet.has(o)) ops.push({ type: "delete", name: o });
			for (const n of lines) if (!origSet.has(n)) ops.push({ type: "create", name: n });
		}

		if (ops.length === 0) {
			new Notice("変更はありません。");
			return;
		}

		const deletions = ops.filter((o): o is Extract<Op, { type: "delete" }> => o.type === "delete");
		if (deletions.length > 0) {
			// CodeMirror/Vim reacts to raw DOM focus, not to which window is
			// visually on top. If we leave the editor focused, the very
			// first Enter meant for the confirmation dialog still lands on
			// Vim (e.g. triggering "open entry") before the modal's own
			// focused button ever sees it. Blurring first — which also pops
			// our Escape-swallowing Scope via the existing focusout handler
			// — ensures the modal is the only thing listening once it opens.
			this.editorView.contentDOM.blur();
			const ok = await confirmModal(
				this.app,
				`${deletions.length}件を削除します:\n${deletions.map((d) => d.name).join("\n")}`,
				"削除する"
			);
			if (!ok) {
				this.editorView.focus();
				return;
			}
		}

		let applied = 0;
		for (const op of ops) {
			try {
				if (op.type === "rename") {
					const fromPath = this.currentPath
						? `${this.currentPath}/${stripSlash(op.from)}`
						: stripSlash(op.from);
					const toPath = this.currentPath
						? `${this.currentPath}/${stripSlash(op.to)}`
						: stripSlash(op.to);
					const af = this.app.vault.getAbstractFileByPath(fromPath);
					if (af) {
						await this.app.fileManager.renameFile(af, toPath);
						applied++;
					}
				} else if (op.type === "create") {
					const dir = isDirEntry(op.name);
					const name = stripSlash(op.name);
					const fullPath = this.currentPath ? `${this.currentPath}/${name}` : name;
					if (dir) await this.app.vault.createFolder(fullPath);
					else await this.app.vault.create(fullPath, "");
					applied++;
				} else if (op.type === "delete") {
					const name = stripSlash(op.name);
					const fullPath = this.currentPath ? `${this.currentPath}/${name}` : name;
					const af = this.app.vault.getAbstractFileByPath(fullPath);
					if (af) {
						await this.app.fileManager.trashFile(af);
						applied++;
					}
				}
			} catch (e) {
				new Notice(`エラー: ${(e as Error).message}`);
			}
		}

		new Notice(`${applied}件の変更を適用しました。`);
		await this.setPath(this.currentPath);
	}

	async onClose() {
		if (this.oilScopePushed) {
			this.app.keymap.popScope(this.oilScope);
			this.oilScopePushed = false;
		}
		this.editorView?.destroy();
	}
}

export default class OilExplorerPlugin extends Plugin {
	/** "auto" mirrors Obsidian's core "Vim key bindings" editor setting; "on"/"off" force it for Oil views. */
	vimPreference: VimPreference = "auto";

	async onload() {
		this.registerView(OIL_VIEW_TYPE, (leaf: WorkspaceLeaf) => new OilView(leaf, this));

		this.addCommand({
			id: "open-oil-here",
			name: "現在のフォルダをOilで開く",
			callback: () => void this.openOil(),
		});

		this.addCommand({
			id: "toggle-vim-mode",
			name: "Vimキーバインドの切り替え（自動 → ON → OFF）",
			callback: () => this.cycleVimPreference(),
		});

		this.addRibbonIcon("folder-open", "Oil Explorerを開く", () => void this.openOil());
	}

	private cycleVimPreference() {
		const order: VimPreference[] = ["auto", "on", "off"];
		const next = order[(order.indexOf(this.vimPreference) + 1) % order.length];
		this.vimPreference = next;

		const labels: Record<VimPreference, string> = {
			auto: "自動（Obsidianの設定に従う）",
			on: "強制ON",
			off: "強制OFF",
		};
		new Notice(`Oil ExplorerのVimキーバインド: ${labels[next]}`);

		for (const leaf of this.app.workspace.getLeavesOfType(OIL_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof OilView) {
				const doc = view.editorView.state.doc.toString();
				view.buildEditor(doc);
			}
		}
	}

	private async openOil() {
		const activeFile = this.app.workspace.getActiveFile();
		const folderPath = activeFile?.parent?.path ?? "";

		let leaf = this.app.workspace.getLeavesOfType(OIL_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeaf("tab");
			await leaf.setViewState({ type: OIL_VIEW_TYPE, active: true });
		}
		this.app.workspace.revealLeaf(leaf);

		const view = leaf.view;
		if (view instanceof OilView) {
			await view.setPath(folderPath);
		}
	}

	onunload() {
		// no-op; Obsidian detaches registered views automatically
	}
}

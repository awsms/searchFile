import { App, Plugin, SuggestModal, TFile, WorkspaceLeaf } from "obsidian";

/**
 * Gather paths of all currently open files (any file-based view)
 */
function getOpenFilePaths(app: App): Set<string> {
	const openPaths = new Set<string>();
	app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
		const vs = leaf.getViewState() as any;
		if (vs.state && typeof vs.state.file === "string") {
			openPaths.add(vs.state.file);
		}
	});
	return openPaths;
}

/**
 * In-memory content index to enable "Ctrl+P"-style searching.
 * - Stores lowercased text for each file path
 * - Updates on file changes
 *
 * Notes:
 * - This is a simple index (substring search). It's fast enough for many vaults,
 *   but for very large vaults you may want a real tokenizer / incremental search.
 */
class ContentIndex {
	private app: App;
	private textByPath = new Map<string, string>(); // lowercased
	private building = false;

	// guardrails
	private readonly maxFileBytes = 1_000_000; // 1MB per file
	private readonly indexExtensions = new Set(["md", "txt", "canvas"]);

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * Start (re)building the index in the background.
	 */
	async buildInitialIndex(): Promise<void> {
		if (this.building) return;
		this.building = true;

		try {
			const files = this.app.vault.getFiles();

			// Build sequentially to avoid hammering IO
			for (let i = 0; i < files.length; i++) {
				const f = files[i];
				await this.indexFileIfEligible(f);

				// yield to UI occasionally
				if (i % 30 === 0) {
					await new Promise((r) => window.setTimeout(r, 0));
				}
			}
		} finally {
			this.building = false;
		}
	}

	/**
	 * Update / remove index entry based on file.
	 */
	async indexFileIfEligible(file: TFile): Promise<void> {
		// extension filter
		if (!this.indexExtensions.has(file.extension)) {
			this.textByPath.delete(file.path);
			return;
		}

		// size filter
		if (typeof file.stat?.size === "number" && file.stat.size > this.maxFileBytes) {
			this.textByPath.delete(file.path);
			return;
		}

		try {
			const raw = await this.app.vault.cachedRead(file);
			this.textByPath.set(file.path, raw.toLowerCase());
		} catch {
			// if read fails, just drop it from index
			this.textByPath.delete(file.path);
		}
	}

	remove(file: TFile): void {
		this.textByPath.delete(file.path);
	}

	rename(oldPath: string, file: TFile): void {
		const v = this.textByPath.get(oldPath);
		if (v !== undefined) {
			this.textByPath.delete(oldPath);
			this.textByPath.set(file.path, v);
		}
	}

	/**
	 * Find a content match snippet for a file path, or null.
	 */
	findSnippet(path: string, query: string): { snippet: string; at: number } | null {
		const text = this.textByPath.get(path);
		if (!text) return null;

		const idx = text.indexOf(query);
		if (idx === -1) return null;

		// create a short snippet around the match
		const start = Math.max(0, idx - 40);
		const end = Math.min(text.length, idx + query.length + 60);
		let snippet = text.slice(start, end);

		// try to "pretty up" whitespace
		snippet = snippet.replace(/\s+/g, " ").trim();
		if (start > 0) snippet = "… " + snippet;
		if (end < text.length) snippet = snippet + " …";

		return { snippet, at: idx };
	}

	/**
	 * Check if file content contains query.
	 */
	contains(path: string, query: string): boolean {
		const text = this.textByPath.get(path);
		return !!text && text.includes(query);
	}
}

/**
 * What we show in the picker:
 * - A file + optional snippet if match came from content
 */
type SearchResult = {
	file: TFile;
	isOpen: boolean;
	isActive: boolean;
	matchIn: "path" | "content";
	snippet?: string;
};

class FileSearchModal extends SuggestModal<SearchResult> {
	private allFiles: TFile[];
	private openFilePaths: Set<string>;
	private activeFilePath: string | null;
	private index: ContentIndex;

	constructor(app: App, openPaths: Set<string>, index: ContentIndex) {
		super(app);
		this.setPlaceholder("Type to search files (name + content) …");
		this.allFiles = app.vault.getFiles();
		this.openFilePaths = openPaths;
		this.activeFilePath = app.workspace.getActiveFile()?.path ?? null;
		this.index = index;
	}

	getSuggestions(query: string): SearchResult[] {
		const q = query.trim().toLowerCase();
		if (!q) return [];

		// for tiny queries, searching content can be noisy/slow
		const searchContent = q.length >= 3;

		const results: SearchResult[] = [];

		for (const f of this.allFiles) {
			const isActive = this.activeFilePath === f.path;
			const isOpen = this.openFilePaths.has(f.path);

			const pathLc = f.path.toLowerCase();
			const pathHit = pathLc.includes(q);

			let contentHit = false;
			let snippet: string | undefined;

			if (!pathHit && searchContent) {
				const sn = this.index.findSnippet(f.path, q);
				if (sn) {
					contentHit = true;
					snippet = sn.snippet;
				}
			}

			if (!pathHit && !contentHit) continue;

			results.push({
				file: f,
				isOpen,
				isActive,
				matchIn: pathHit ? "path" : "content",
				snippet,
			});
		}

		// Rank similar to sublime-ish behavior:
		// 1) active file first
		// 2) open files next
		// 3) filename/path matches before content-only matches
		// 4) then shorter path (often "closer" match), then alpha
		results.sort((a, b) => {
			if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
			if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
			if (a.matchIn !== b.matchIn) return a.matchIn === "path" ? -1 : 1;
			if (a.file.path.length !== b.file.path.length) return a.file.path.length - b.file.path.length;
			return a.file.path.localeCompare(b.file.path);
		});

		// avoid huge lists
		return results.slice(0, 200);
	}

	renderSuggestion(res: SearchResult, el: HTMLElement) {
		el.addClass("suggestion-item");

		const row = el.createDiv({ cls: "sf-row" });

		const left = row.createDiv({ cls: "sf-left" });
		left.createDiv({
			text: res.file.path,
			cls: "sf-path" + (res.isOpen ? " sf-open" : "") + (res.isActive ? " sf-active" : ""),
		});

		const badges = row.createDiv({ cls: "sf-badges" });
		if (res.isActive) badges.createSpan({ cls: "sf-badge sf-badge-active", text: "ACTIVE" });
		else if (res.isOpen) badges.createSpan({ cls: "sf-badge sf-badge-open", text: "OPEN" });

		if (res.matchIn === "content") badges.createSpan({ cls: "sf-badge sf-badge-content", text: "CONTENT" });

		if (res.snippet) {
			el.createDiv({ cls: "sf-snippet", text: res.snippet });
		}
	}

	async onChooseSuggestion(res: SearchResult) {
		const file = res.file;

		let existing: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const vs = leaf.getViewState() as any;
			if (vs.state?.file === file.path) {
				existing = leaf;
				return true;
			}
		});

		if (existing) {
			this.app.workspace.setActiveLeaf(existing, { focus: true });
		} else {
			const leaf = this.app.workspace.getLeaf("tab");
			await leaf.openFile(file);
		}
	}
}

/**
 * Plugin entry point
 */
export default class FileSearchPlugin extends Plugin {
	private index!: ContentIndex;

	async onload() {
		this.index = new ContentIndex(this.app);

		// Build index on startup (async; modal still works immediately for filename hits)
		this.index.buildInitialIndex();

		// Keep index updated
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile) this.index.indexFileIfEligible(file);
			})
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile) this.index.indexFileIfEligible(file);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) this.index.remove(file);
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) this.index.rename(oldPath, file);
			})
		);

		// — IDE-style tab reuse —
		this.registerEvent(
			this.app.workspace.on("file-open", (file: TFile | null) => {
				if (!file) return;
				const matches: WorkspaceLeaf[] = [];
				this.app.workspace.iterateAllLeaves((leaf) => {
					const vs = leaf.getViewState() as any;
					if (vs.state?.file === file.path) matches.push(leaf);
				});
				if (matches.length > 1) {
					const [first, ...dupes] = matches;
					this.app.workspace.setActiveLeaf(first, { focus: true });
					for (const d of dupes) d.detach();
				}
			})
		);

		this.addCommand({
			id: "open-file-search-menu",
			name: "Open File Search Menu",
			callback: () => {
				const openPaths = getOpenFilePaths(this.app);
				new FileSearchModal(this.app, openPaths, this.index).open();
			},
		});
	}
}

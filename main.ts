import { App, Plugin, SuggestModal, TFile, WorkspaceLeaf } from "obsidian";

/**
 * Gather paths of all currently open files (any file‐based view)
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
 * Modal for searching and opening files
 */
class FileSearchModal extends SuggestModal<TFile> {
	allFiles: TFile[];
	openFilePaths: Set<string>;
	activeFilePath: string | null;

	constructor(app: App, openPaths: Set<string>) {
		super(app);
		this.setPlaceholder("Search all vault files...");
		this.allFiles = app.vault.getFiles();
		this.openFilePaths = openPaths;
		// Remember the file in the current active pane (if any)
		this.activeFilePath = app.workspace.getActiveFile()?.path ?? null;
	}

	getSuggestions(query: string): TFile[] {
		const q = query.toLowerCase();

		// 1) The currently active file (if it matches the query)
		const activeMatches = this.activeFilePath && this.activeFilePath.toLowerCase().includes(q)
			? this.allFiles.filter((f) => f.path === this.activeFilePath)
			: [];

		// 2) Other open files (excluding the active one)
		const openMatches = this.allFiles
			.filter((f) => this.openFilePaths.has(f.path) && f.path !== this.activeFilePath)
			.filter((f) => f.path.toLowerCase().includes(q));

		// 3) All remaining files
		const closedMatches = this.allFiles
			.filter((f) => !this.openFilePaths.has(f.path) && f.path !== this.activeFilePath)
			.filter((f) => f.path.toLowerCase().includes(q));

		return [...activeMatches, ...openMatches, ...closedMatches];
	}

	renderSuggestion(file: TFile, el: HTMLElement) {
		const isOpen = this.openFilePaths.has(file.path);
		el.addClass("suggestion-item");
		if (isOpen) el.addClass("file-suggestion-open-item");
		el.createSpan({
			text: file.path,
			cls: isOpen ? "file-suggestion-open" : "",
		});
	}

	async onChooseSuggestion(file: TFile) {
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
	async onload() {
		// — IDE-style tab reuse —
		this.registerEvent(
			this.app.workspace.on("file-open", (file: TFile | null) => {
				if (!file) return;
				const matches: WorkspaceLeaf[] = [];
				this.app.workspace.iterateAllLeaves((leaf) => {
					const vs = leaf.getViewState() as any;
					if (vs.state?.file === file.path) {
						matches.push(leaf);
					}
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
				new FileSearchModal(this.app, openPaths).open();
			},
		});
	}
}

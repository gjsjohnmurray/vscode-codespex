import{ CancellationToken, commands, Comment, CommentMode, CommentReaction, comments, CommentThread, CommentThreadCollapsibleState, CommentThreadState, ExtensionContext, extensions, Hover, MarkdownString, MarkedString, Range, SemanticTokens, SemanticTokensLegend, TextDocument, TextEditor, Uri, window, workspace } from 'vscode';

export async function activate(context: ExtensionContext): Promise<void> {

	console.log(`Now activating ${context.extension.id}`);
  
	const { displayName, icon }= context.extension.packageJSON;

	// To use an icon from a local file we have to use a special uri
	const iconPath = Uri.from({ scheme: 'vscode-file', authority: 'vscode-app', path: '/' + context.asAbsolutePath(icon)});

	const myIdentity = `${displayName} (${context.extension.id})`;
	const REACTION_MUTE = { label: 'Mute', iconPath, count: 0, authorHasReacted: false };

	// A `CommentController` contributes to VS Code's commenting UI
	const commentController = comments.createCommentController('codespex', 'codeSpex');
 	commentController.reactionHandler = async (comment: Comment, reaction: CommentReaction) => {
		console.log(`codeSpex reaction handler got reaction '${reaction.label}' on comment '${(comment.body as MarkdownString).value.toString().split('\n', 1)[0]}'`);
		return;
	};

	const commentThreadsMap = new Map<string, CommentThread[]>();
	addVisibleEditorThreads(window.visibleTextEditors);

	context.subscriptions.push(
		commands.registerCommand('codespex.dismissAllOnActive', () => {
			const uri = window.activeTextEditor?.document.uri;
			if (uri) {
				const myThreads = commentThreadsMap.get(uri.toString());
				while (myThreads && myThreads.length > 0) {
					myThreads.pop()?.dispose();
				};
			}
		}),
		commands.registerCommand('codespex.muteThread', (thread: CommentThread) => {
			console.log(`codespex.muteThread: ${thread.label} in ${thread.uri.toString(true)}`);
			thread.dispose();
		}),
		commands.registerCommand('codespex.resolveThread', (thread: CommentThread) => {
			console.log(`codespex.resolveThread: ${thread.label} in ${thread.uri.toString(true)}`);
			thread.state = CommentThreadState.Resolved;
			thread.contextValue = 'resolved';
			thread.collapsibleState = CommentThreadCollapsibleState.Collapsed;
		}),
		commands.registerCommand('codespex.unresolveThread', (thread: CommentThread) => {
			console.log(`codespex.unresolveThread: ${thread.label} in ${thread.uri.toString(true)}`);
			thread.state = CommentThreadState.Unresolved;
			thread.collapsibleState = CommentThreadCollapsibleState.Expanded;
			thread.contextValue = 'unresolved';
		}),
		commands.registerCommand('codespex.resolveTokenType', (thread: CommentThread) => {
			console.log(`TODO codespex.resolveTokenType: ${thread.label} in ${thread.uri.toString(true)}`);
		}),
		commands.registerCommand('codespex.excludeToken', (thread: CommentThread) => {
			console.log(`TODO codespex.excludeToken: ${thread.label} in ${thread.uri.toString(true)}`);
		}),
		commands.registerCommand('codespex.excludeToken.global', (thread: CommentThread) => {
			console.log(`TODO codespex.excludeToken.global: ${thread.label}`);
		}),
		window.onDidChangeVisibleTextEditors((editors) => {
			console.log(`onDidChangeVisibleTextEditors: ${editors.length}`);
			addVisibleEditorThreads(editors);
		})
	);

	function addVisibleEditorThreads(editors: readonly TextEditor[]) {
		editors.forEach(async (editor) => {
			const doc = editor.document;
			await addDocumentThreads(doc);
		});
	}
	
	async function addDocumentThreads(doc: TextDocument) {
		const LANGUAGES = ['objectscript', 'objectscript-class', 'objectscript-csp', 'objectscript-int', 'objectscript-macros'];
		const TARGETS = ['CLS_ClassName', 'CLS_ClassMember', 'COS_Objectname', 'COS_Objectmember', 'COS_Objectmethod'];
		const uri = doc.uri;
		const mapKey = uri.toString();
		if (LANGUAGES.includes(doc.languageId) && !commentThreadsMap.has(mapKey)) {
			const commentThreads: CommentThread[] = [];

			// TODO - discover why the active editor loaded by hot-backup resume doesn't get any STs (nor therefore an ST legend).
			const legend: SemanticTokensLegend = await commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', uri);
			if (legend) {
				const mapNameToId = new Map<string, number>();
				const mapIdToName = new Map<number, string>();
				legend.tokenTypes.forEach((value, index) => {
					if (TARGETS.includes(value)) {
						mapNameToId.set(value, index);
						mapIdToName.set(index, value);
					}
				});
				if (mapNameToId.size > 0) {
					const tokens: SemanticTokens = await commands.executeCommand('vscode.provideDocumentSemanticTokens', uri);
					const targetRangesMap = new Map<string, Range[]>();

					// Scan tokens
					let line = 0;
					let character = 0;

					// Use length /2 below because LS seems to send duplicate set of tokens with line numbers offset by 2**32 or thereabouts
					for (let index = 0; index < tokens.data.length / 2; index += 5) {
						line += tokens.data[index];
						if (tokens.data[index] > 0) {
							character = 0;
						}
						character += tokens.data[index + 1];
						const length = tokens.data[index + 2];
						const tokenName = mapIdToName.get(tokens.data[index + 3]);
						if (tokenName) {
							const ranges = targetRangesMap.get(tokenName) ?? [];
							const insertBefore = ranges.findIndex((range) => {
								if (range.start.line > line) {
									return true;
								}
								if (range.start.line === line && range.start.character > character) {
									return true;
								}
								return false;
							});
							const myRange = new Range(line, character, line, character + length);
							const newRanges = insertBefore === -1 ? [...ranges, myRange] : [...ranges.slice(0, insertBefore - 1), myRange, ...ranges.slice(insertBefore)];
							targetRangesMap.set(tokenName, newRanges);
						}
					}

					// Merge adjacents
					TARGETS.forEach((tokenName) => {
						const ranges = targetRangesMap.get(tokenName);
						if (ranges) {
							for (let index = ranges.length - 1; index > 0; index--) {
								const element = ranges[index];
								const before = ranges[index - 1];
								if (before.end.character === element.start.character && before.end.line === element.start.line) {
									ranges.splice(index, 1);
									ranges[index - 1] = before.with(undefined, element.end);
								}
							}
							targetRangesMap.set(tokenName, ranges);
						}
					});

					// Add threads
					targetRangesMap.forEach((ranges, tokenName) => {
						ranges.forEach(async (range) => {
							const hovers: Hover[] = await commands.executeCommand('vscode.executeHoverProvider', uri, range.end);
							if (hovers.length > 0) {
								let body: MarkdownString;

								const contents = hovers[0].contents;
								body = new MarkdownString(
									contents.map((content): string => {
										return (content as MarkdownString).value;
									}).join('\n\n'));

								const comment: Comment = {
									body,
									author: { name: 'gj :: codeSpex', iconPath },
									mode: CommentMode.Preview,
									reactions: [
										REACTION_MUTE
									]
								};
								const commentThread = commentController.createCommentThread(uri, range, [comment]);
								commentThread.label = `${doc.getText(range).split('\n')[0]} (${tokenName})`;
								commentThread.label += ` [Ln ${range.start.line + 1}, Col ${range.start.character + 1} to Ln ${range.end.line + 1}, Col ${range.end.character + 1}]`;
								commentThread.canReply = false;
								commentThread.state = CommentThreadState.Unresolved;
								commentThread.contextValue = 'unresolved';
								commentThreads.push(commentThread);
							}
						});
					});
				}
				commentThreadsMap.set(mapKey, commentThreads);
			}
		}
	}
}

export function deactivate() {}

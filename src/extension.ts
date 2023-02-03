import{ CancellationToken, commands, Comment, CommentMode, CommentReaction, comments, CommentThread, CommentThreadState, ExtensionContext, Hover, MarkdownString, MarkedString, Range, SemanticTokens, SemanticTokensLegend, TextDocument, TextEditor, Uri, window, workspace } from 'vscode';

export async function activate(context: ExtensionContext): Promise<void> {

	console.log(`Now activating ${context.extension.id}`);
	
	const { displayName, icon }= context.extension.packageJSON;
	const iconPath = Uri.file(context.asAbsolutePath(icon));
	const myIdentity = `${displayName} (${context.extension.id})`;
	const REACTION_DISMISS = { label: 'Dismiss', iconPath, count: 0, authorHasReacted: false };
	const REACTION_REINSTATE = { label: 'Reinstate', iconPath, count: 0, authorHasReacted: false };

	// A `CommentController` contributes to VS Code's commenting UI
	const commentController = comments.createCommentController('georgejames.codespex', 'codeSpex');
	commentController.options = { placeHolder: 'codeSpex CommentController options.placeholder', prompt: 'codeSpex CommentController options.prompt' };
/* 	commentController.reactionHandler = async (comment: Comment, reaction: CommentReaction) => {
		console.log(`codeSpex reaction handler got reaction ${reaction} on comment ${comment}`);
		return;
	};
 */
	const commentThreadsMap = new Map<string, CommentThread[]>();
	addVisibleEditorThreads(window.visibleTextEditors);

	context.subscriptions.push(
		commands.registerCommand('georgejames.codespex.dismissAllOnActive', () => {
			const uri = window.activeTextEditor?.document.uri;
			if (uri) {
				const myThreads = commentThreadsMap.get(uri.toString());
				while (myThreads && myThreads.length > 0) {
					myThreads.pop()?.dispose();
				};
			}
		}),
		commands.registerCommand('georgejames.codespex.dismissThread', (thread: CommentThread) => {
			console.log(`georgejames.codespex.dismissThread: ${thread}`);
			thread.dispose();
		}),
		workspace.onDidOpenTextDocument((doc) => {
			console.log(`onDidOpenTextDocument for ${doc.uri.toString(true)}`);
		}),
		window.onDidChangeVisibleTextEditors((editors) => {
			console.log(`onDidChangeVisibleTextEditors: ${editors.length}`);
			addVisibleEditorThreads(editors);
		})
	);

	function addVisibleEditorThreads(editors: readonly TextEditor[]) {
		const TARGETS = ['CLS_ClassName', 'CLS_Identifier'];
		editors.forEach(async (editor) => {
			const doc = editor.document;
			const uri = doc.uri;
			const mapKey = uri.toString();
			if (uri.scheme !== 'comment' && !commentThreadsMap.has(mapKey)) {
				const commentThreads: CommentThread[] = [];
				const legend: SemanticTokensLegend = await commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', uri);
				if (legend) {
					const mapNameToId = new Map<string,number>();
					const mapIdToName = new Map<number,string>();
					legend.tokenTypes.forEach((value, index) => {
						if (TARGETS.includes(value)) {
							mapNameToId.set(value, index);
							mapIdToName.set(index, value);
						}
					});
					if (mapNameToId.size > 0) {
						const tokens: SemanticTokens = await commands.executeCommand('vscode.provideDocumentSemanticTokens', uri);
						const targetRangesMap = new Map<string,Range[]>();

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
								targetRangesMap.set(tokenName, [...targetRangesMap.get(tokenName) ?? [], new Range(line, character, line, character + length)]);
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
								const hovers: Hover[] = await commands.executeCommand('vscode.executeHoverProvider', uri, range.start);
								if (hovers.length > 0) {
									let body: MarkdownString;

									const contents = hovers[0].contents;
									body = new MarkdownString(
										contents.map((content): string => {
											return (content as MarkdownString).value;
										}).join('\n\n'));
									
									const comment: Comment = { body, author: { name: 'codeSpex', iconPath }, mode: CommentMode.Preview };
									const commentThread = commentController.createCommentThread(uri, range, [comment]);
									commentThread.label = `Ln${range.start.line + 1},Ch${range.start.character + 1} to Ln${range.end.line + 1},Ch${range.end.character + 1} (${tokenName})`;
									commentThread.canReply = false;
									commentThreads.push(commentThread);
								}
							});
						});
					}
				}
				commentThreadsMap.set(mapKey, commentThreads);
			}
		});
	}
}

export function deactivate() {}

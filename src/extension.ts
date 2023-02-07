import{ CancellationToken, commands, Comment, CommentMode, CommentReaction, comments, CommentThread, CommentThreadCollapsibleState, CommentThreadState, ExtensionContext, extensions, Hover, MarkdownString, MarkedString, Range, SemanticTokens, SemanticTokensLegend, TextDocument, TextEditor, Uri, window, workspace } from 'vscode';

export async function activate(context: ExtensionContext): Promise<void> {

	console.log(`Now activating ${context.extension.id}`);
  
	const { displayName, icon }= context.extension.packageJSON;

	// To use an icon from a local file as the author avatar we have to use a special uri
	// TODO - get this to work on remote (container) workspaces and GitHub Codespaces
	const iconPath = Uri.from({ scheme: 'vscode-file', authority: 'vscode-app', path: '/' + context.asAbsolutePath(icon)});

	const myIdentity = `${displayName} (${context.extension.id})`;
	const REACTION_MUTE = { label: 'Mute', iconPath, count: 0, authorHasReacted: false };

	// A `CommentController` contributes to VS Code's commenting UI
	const commentController = comments.createCommentController('codeSpex', 'codeSpex');
 	commentController.reactionHandler = async (comment: Comment, reaction: CommentReaction) => {
		console.log(`TODO codeSpex reaction handler got reaction '${reaction.label}' on comment '${(comment.body as MarkdownString).value.toString().split('\n', 1)[0]}'`);
		return;
	};

	// Map to hold all our CommentThreads per document. Key is uri.toString()
	const mapCommentThreads = new Map<string, CommentThread[]>();

	// Add comments to docs already open at startup. Deferred so language server will be ready to provide tokens.
	setTimeout(() => {addVisibleEditorThreads(window.visibleTextEditors);},	1000);

	context.subscriptions.push(
		commands.registerCommand('codeSpex.dismissAllOnActive', () => {
			const uri = window.activeTextEditor?.document.uri;
			if (uri) {
				const myThreads = mapCommentThreads.get(uri.toString());
				while (myThreads && myThreads.length > 0) {
					myThreads.pop()?.dispose();
				};
			}
		}),
		commands.registerCommand('codeSpex.muteThread', (thread: CommentThread) => {
			console.log(`codeSpex.muteThread: ${thread.label} in ${thread.uri.toString(true)}`);
			thread.dispose();
		}),
		commands.registerCommand('codeSpex.resolveThread', (thread: CommentThread) => {
			console.log(`codeSpex.resolveThread: ${thread.label} in ${thread.uri.toString(true)}`);
			resolveThread(thread);
		}),
		commands.registerCommand('codeSpex.unresolveThread', (thread: CommentThread) => {
			console.log(`codeSpex.unresolveThread: ${thread.label} in ${thread.uri.toString(true)}`);
			thread.state = CommentThreadState.Unresolved;
			thread.collapsibleState = CommentThreadCollapsibleState.Expanded;

			const data = (thread.contextValue || '').split(':');
			data[0] = 'unresolved';
			thread.contextValue = data.join(':');
		}),
		commands.registerCommand('codeSpex.resolveToken', (thread: CommentThread) => {
			// In the document owning the thread this command was invoked from, resolve all threads about the same token (name and value)
			console.log(`codeSpex.resolveToken: ${thread.label} in ${thread.uri.toString(true)}`);
			mapCommentThreads.get(thread.uri.toString())?.forEach((oneThread) => {
				if (tokenName(oneThread) === tokenName(thread) && tokenValue(oneThread) === tokenValue(thread)) {
					resolveThread(oneThread);
				}
			});
		}),
		commands.registerCommand('codeSpex.resolveTokenEverywhere', (thread: CommentThread) => {
			// In all commented documents, resolve all threads about the same token (name and value) as the one this command was invoked from
			console.log(`codeSpex.resolveTokenEverywhere: ${thread.label} in ${thread.uri.toString(true)}`);
			mapCommentThreads.forEach((threads, uriString) => {
				threads.forEach((oneThread) => {
					if (tokenName(oneThread) === tokenName(thread) && tokenValue(oneThread) === tokenValue(thread)) {
						resolveThread(oneThread);
					}
				});
			});
		}),
		commands.registerCommand('codeSpex.excludeToken', (thread: CommentThread) => {
			console.log(`TODO codeSpex.excludeToken: ${thread.label} in ${thread.uri.toString(true)}`);
		}),
		commands.registerCommand('codeSpex.excludeToken.global', (thread: CommentThread) => {
			console.log(`TODO codeSpex.excludeToken.global: ${thread.label}`);
		}),
		window.onDidChangeVisibleTextEditors(async (editors) => {
			//console.log(`onDidChangeVisibleTextEditors: ${editors.length}`);
			await addVisibleEditorThreads(editors);
		}),
		workspace.onDidCloseTextDocument((doc: TextDocument) => {
			// Remove comments upon close
			const mapKey = doc.uri.toString();
			(mapCommentThreads.get(mapKey) ?? []).forEach((thread: CommentThread) => {
				thread.dispose();
			});
			mapCommentThreads.delete(mapKey);
		})
	);

	function tokenName(thread: CommentThread): string {
		return (thread.contextValue || '').split(':')[1];
	}

	function tokenValue(thread: CommentThread): string {
		return (thread.contextValue || '').split(':')[2];
	}

	function resolveThread(thread: CommentThread) {
		if (thread.state === CommentThreadState.Unresolved) {			
			thread.state = CommentThreadState.Resolved;
			const data = (thread.contextValue || '').split(':');
			data[0] = 'resolved';
			thread.contextValue = data.join(':');
		}
	}

	async function addVisibleEditorThreads(editors: readonly TextEditor[]) {
		await Promise.all(editors.map(async (editor) => {
			const doc = editor.document;
			await addDocumentThreads(doc);
		}));
	}
	
	async function addDocumentThreads(doc: TextDocument) {
		const uri = doc.uri;
		const mapKey = uri.toString();

		// Bale out if already done, even if all comment threads subsequently deleted
		if (mapCommentThreads.has(mapKey)) {
			return;
		}
		
		// For the doc's language, which token types are wanted?
		// TODO - cache this per languageId
		const confTokenNames: {[k: string]: any} = workspace.getConfiguration(`codeSpex.languages.${doc.languageId}`, doc).get('tokens') || [];
		const TARGETS: string[] = [];
		if (typeof confTokenNames === "object" && confTokenNames) {
			for (const tokenName in confTokenNames) {
				if (confTokenNames[tokenName].enabled) {
					TARGETS.push(tokenName);
					
					// TODO add a configuration structure for selecting which modifiers we want, then load it here and check it below
				}
			}
		}
		
		// Bale out if nothing of interest
		if (TARGETS.length === 0) {
			return;
		}
		
		// Add the empty array to the map before calling async command, in order to prevent re-entry
		const commentThreads: CommentThread[] = [];
		mapCommentThreads.set(mapKey, commentThreads);

		// Get tokens legend, and bale out if nothing to handle, after removing empty array
		const legend: SemanticTokensLegend = await commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', uri);
		if (!legend?.tokenTypes.length) {
			mapCommentThreads.delete(mapKey);
			return;
		}

		const mapIdToName = new Map<number, string>();
		legend.tokenTypes.forEach((value, index) => {
			if (TARGETS.includes(value)) {
				mapIdToName.set(index, value);
			}
		});

		// Bale out if not interested in any of the tokens in the legend
		if (mapIdToName.size === 0) {
			return;
		}

		const modifier: string[] = [];
		legend.tokenModifiers.forEach((value, index) => {
			modifier[index] = value;
		});

		// Get the STs
		const tokens: SemanticTokens = await commands.executeCommand('vscode.provideDocumentSemanticTokens', uri);
		const targetRangesMap = new Map<string, Range[]>();

		// Scan tokens
		let line = 0;
		let character = 0;

		// Use length /2 below because InterSystems LS seems to send duplicate set of tokens with line numbers offset by 2**32 or thereabouts.
		// TODO - why is that, and what happens if config declares interest in a language implemented by a different SemanticTokenProvider?
		for (let index = 0; index < tokens.data.length / 2; index += 5) {
			line += tokens.data[index];
			if (tokens.data[index] > 0) {
				character = 0;
			}
			character += tokens.data[index + 1];
			const length = tokens.data[index + 2];
			const tokenId = tokens.data[index + 3];
			const tokenName = mapIdToName.get(tokenId);
			if (tokenName) {
				const modifierBits = tokens.data[index + 4];

				// TODO check modifiers match what we are interested in (see above)

				// Add it to the Range[] being accumulated for this token
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

		// Merge adjacent entities (InterSystems LS sometimes returns these)
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

		// Local async function to add a comment thread for a range
		const addThreadForRange = async (tokenName: string, range: Range) => {

			// Ask for the hover that would appear if the pointer was on the end of the range
			// Using end seemed more reliable that using start(at least for InterSystems LS)
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
				const tokenValue = doc.getText(range).split('\n')[0];
				commentThread.label = `${tokenValue} (${tokenName})`;
				commentThread.label += ` [Ln ${range.start.line + 1}, Col ${range.start.character + 1} to Ln ${range.end.line + 1}, Col ${range.end.character + 1}]`;
				commentThread.canReply = false;
				commentThread.state = CommentThreadState.Unresolved;
				commentThread.collapsibleState = CommentThreadCollapsibleState.Collapsed;

				// Handle occurrences of default %-package, e.g. %Integer meaning %Library.Integer
				// TODO move this InterSystems-LS-token-specific transform into configuration 
				const canonicalValue = tokenName.startsWith('CLS_Class') || (tokenName === 'COS_Objectname')
					? tokenValue.replace(/^%(?!.*\.)/, '%Library.')
					: tokenValue;
				
				commentThread.contextValue = `unresolved:${tokenName}:${canonicalValue}`;
				commentThreads.push(commentThread);
			}
		};

		// Add comment threads, preserving the sequence in which token types were found, and within each token type the sequence in which the tokens occurred
		for (const mapPair of targetRangesMap) {
			const tokenName = mapPair[0];
			const ranges = mapPair[1];
			for (const range of ranges) {
				await addThreadForRange(tokenName, range);
			}
		};
	}
}

export function deactivate() {}

import{ commands, Comment, CommentMode, CommentReaction, comments, CommentThread, CommentThreadCollapsibleState, CommentThreadState, ExtensionContext, extensions, Hover, MarkdownString, MarkedString, Range, SemanticTokens, SemanticTokensLegend, TextDocument, TextDocumentChangeReason, TextDocumentContentChangeEvent, TextEditor, Uri, window, workspace } from 'vscode';

export async function activate(context: ExtensionContext): Promise<void> {

	console.log(`Now activating ${context.extension.id}`);
  
	const { displayName, icon }= context.extension.packageJSON;

	// To use an icon from a local file as the author avatar we have to use a special uri
	// TODO - get this to work on remote (container) workspaces and GitHub Codespaces
	const iconPath = Uri.from({ scheme: 'vscode-file', authority: 'vscode-app', path: '/' + context.asAbsolutePath(icon)});

	const myIdentity = `${displayName} (${context.extension.id})`;
	
	//const REACTION_MUTE = { label: 'Mute', iconPath: Uri.file(context.asAbsolutePath(icon)), count: 0, authorHasReacted: false };

	// A `CommentController` contributes to VS Code's commenting UI
	const commentController = comments.createCommentController('codeSpex', 'codeSpex');

/*  	commentController.reactionHandler = async (comment: Comment, reaction: CommentReaction) => {
		console.log(`TODO codeSpex reaction handler got reaction '${reaction.label}' on <${comment.contextValue}> comment '${(comment.body as MarkdownString).value.toString().split('\n', 1)[0]}'`);
		return;
	};
 */

	// Map to hold all our CommentThreads per document. Key is uri.toString()
	const mapCommentThreads = new Map<string, CommentThread[]>();

	// Map to hold reload timers. Key is uri.toString()
	const mapThreadReloaders = new Map<string, NodeJS.Timeout>();

	// Add comments to docs already open at startup. Deferred so language server will be ready to provide tokens.
	setTimeout(() => {addVisibleEditorThreads(window.visibleTextEditors);},	1_000);

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
		commands.registerCommand('codeSpex.excludeToken', async (thread: CommentThread) => {
			//console.log(`TODO codeSpex.excludeToken: ${thread.label} <${thread.contextValue}> in ${thread.uri.toString(true)}`);
			await addExclusion(thread, false);
		}),
		commands.registerCommand('codeSpex.excludeToken.global', async (thread: CommentThread) => {
			//console.log(`TODO codeSpex.excludeToken.global: ${thread.label} <${thread.contextValue}>`);
			await addExclusion(thread, true);
		}),
		commands.registerCommand('codeSpex.toggleCommenting', () => {
			commands.executeCommand('workbench.action.toggleCommenting');
		}),
		window.onDidChangeVisibleTextEditors(async (editors) => {
			//console.log(`onDidChangeVisibleTextEditors: ${editors.length}`);
			await addVisibleEditorThreads(editors);
		}),
		workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('codeSpex.languages')) {

				// Build a map of everything that has comments
				const toRebuild = new Map<string, null>();
				mapCommentThreads.forEach((_value, key) => {
					toRebuild.set(key, null);
				});

				// Rebuild active document's comments first
				const doc = window.activeTextEditor?.document;
				if (doc) {
					addDocumentThreads(doc, true);
					toRebuild.delete(doc.uri.toString());
				}

				// Next the visible ones
				window.visibleTextEditors.forEach((editor) => {
					const document = editor.document;
					if (toRebuild.has(document.uri.toString())) {
						addDocumentThreads(document, true);
						toRebuild.delete(document.uri.toString());
					}
				});

				// The rest
				toRebuild.forEach((_value, key) => {
					const document = workspace.textDocuments.find((document) => key === document.uri.toString());
					if (document) {
						addDocumentThreads(document, true);
					}
				});
			}
		}),
		workspace.onDidChangeTextDocument((event) => {
			// TODO Only set reload timer for document whose languageId we are interested in.
			// TODO Can we use event.contentChanges to be smarter about updating our comment threads?
			if (event.contentChanges.length === 0) {
				return;
			}

			const mapKey = event.document.uri.toString();

			// Abort any outstanding timer
			const oldTimeout = mapThreadReloaders.get(mapKey);
			if (oldTimeout) {
				clearTimeout(oldTimeout);
			}

			// Start a new one
			mapThreadReloaders.set(mapKey, setTimeout(() => {
				// Remove self from map
				mapThreadReloaders.delete(mapKey);

				// Remove and add them again
				addDocumentThreads(event.document, true);
			}, 3_000));
		}),
		workspace.onDidCloseTextDocument((doc: TextDocument) => {
			// Upon close, remove reload timer and comments
			const mapKey = doc.uri.toString();
			const timeout = mapThreadReloaders.get(mapKey);
			if (timeout) {
				clearTimeout(timeout);
			}
			mapThreadReloaders.delete(mapKey);
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

	async function addVisibleEditorThreads(editors: readonly TextEditor[], reset?: boolean) {
		await Promise.all(editors.map(async (editor) => {
			const doc = editor.document;
			await addDocumentThreads(doc, reset);
		}));
	}
	
	async function addDocumentThreads(doc: TextDocument, reset?: boolean) {
		const uri = doc.uri;
		const mapKey = uri.toString();

		if (reset) {
			// Clear existing comments
			(mapCommentThreads.get(mapKey) ?? []).forEach((thread: CommentThread) => {
				thread.dispose();
			});
			mapCommentThreads.delete(mapKey);
		}
		else {
			// Bale out if already done, even if all comment threads subsequently deleted
			if (mapCommentThreads.has(mapKey)) {
				return;
			}
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
		const mapNameToId = new Map<string, number>();
		const mapNameToExclusions = new Map<string, string[]>();
		legend.tokenTypes.forEach((value, index) => {
			if (TARGETS.includes(value)) {
				mapIdToName.set(index, value);
				mapNameToId.set(value, index);

				// Aggregate the exclusions from the two levels we make it easy to set them at.
				const inspectedExclusions = workspace.getConfiguration(`codeSpex.languages.${doc.languageId}.tokens.${value}`, uri).inspect<string[]>('exclusions');
				const allExclusions = [...inspectedExclusions?.globalValue || [], ...inspectedExclusions?.workspaceFolderValue || []];

				// TODO remove duplicates?
				mapNameToExclusions.set(value, allExclusions);
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

		// Cache: per-tokenId array of maps of comment body per canonicalValue of  an instance of a token type
		const bodyMap: Map<string, MarkdownString>[] = [];

		// Local async function to add a comment thread for a range
		const addThreadForRange = async (tokenName: string, range: Range) => {
			const tokenId = mapNameToId.get(tokenName);
			if (typeof tokenId === 'undefined') {
				return;
			}
			const tokenValue = doc.getText(range).split('\n')[0];

			// Handle occurrences of default %-package, e.g. %Integer meaning %Library.Integer
			// TODO move this InterSystems-LS-token-specific transform into configuration 
			const canonicalValue = tokenName.startsWith('CLS_Class') || (tokenName === 'COS_Objectname')
				? tokenValue.replace(/^%(?!.*\.)/, '%Library.')
				: tokenValue;

/* 			if ((mapNameToExclusions.get(tokenName) || []).includes(canonicalValue)) {
				return;
			}
 */
			const exclusions = mapNameToExclusions.get(tokenName) || [];
			for (let index = 0; index < exclusions.length; index++) {
				const exclusion = exclusions[index];
				if (exclusion.endsWith('*')) {
					if (canonicalValue.startsWith(exclusion.slice(0, -1))) {
						return;
					}
				}
				else {
					if (exclusion === canonicalValue) {
						return;
					}
				}
			}
			
			let body = bodyMap[tokenId]?.get(canonicalValue);

			// Not in cache?
			if (!body) {
				// Ask for the hover that would appear if the pointer was on the end of the range
				// Using end seemed more reliable that using start(at least for InterSystems LS)
				const hovers: Hover[] = await commands.executeCommand('vscode.executeHoverProvider', uri, range.end);
				console.log('executeHoverProvider');
				if (hovers.length === 0) {
					return;
				}
				body = new MarkdownString(
					hovers[0].contents.map((content): string => {
						return (content as MarkdownString).value;
					}).join('\n\n'));
				body.supportHtml = true;

				// Add to cache
				if (!bodyMap[tokenId]) {
					bodyMap[tokenId] = new Map<string, MarkdownString>();
				}
				bodyMap[tokenId].set(canonicalValue, body);
			}
			const comment: Comment = {
				contextValue: `${tokenName}:${canonicalValue}`,
				body,
				author: { name: 'codeSpex', iconPath },
				mode: CommentMode.Preview,
/* 				reactions: [
					REACTION_MUTE
				]
 */			};
			const commentThread = commentController.createCommentThread(uri, range, [comment]);
			commentThread.label = `${tokenValue}`;
			commentThread.label += range.start.line === range.end.line
			? ` [Col ${range.start.character + 1}-${range.end.character + 1}]`
			: ` [Ln ${range.start.line + 1}, Col ${range.start.character + 1} to Ln ${range.end.line + 1}, Col ${range.end.character + 1}]`;
			commentThread.label += ` (${tokenName})`;
			commentThread.canReply = false;
			commentThread.state = CommentThreadState.Unresolved;
			commentThread.collapsibleState = CommentThreadCollapsibleState.Collapsed;
			commentThread.contextValue = `unresolved:${tokenName}:${canonicalValue}`;
			commentThreads.push(commentThread);
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

	async function addExclusion(thread: CommentThread, global: boolean) {
			const values = (thread.contextValue || '').split(':');
			const tokenName = values[1];
			const canonicalValue = values[2];
			const doc = workspace.textDocuments.find((document) => thread.uri.toString() === document.uri.toString());
			if (!tokenName || !canonicalValue || !doc) {
				return;
			}

			const parts = canonicalValue.split('.');
			const choices: string[] = [];
			let suffix ='';
			for (let index = parts.length; index > 0; index--) {
				choices.push(parts.slice(0, index).join('.') + suffix);
				if (suffix === '') {
					suffix = '.*';
				}
			}
			if (canonicalValue.startsWith('%')) {
				choices.push('%*');
			}
			const exclusion = await window.showQuickPick(choices, { title: `Set ${global ? 'a Global' : 'an'} Exclusion on '${tokenName}' Token` });
			if (!exclusion) {
				return;
			}

			const languageId = doc.languageId;
			const config = workspace.getConfiguration('codeSpex', global ? undefined : doc.uri);
			const section: any = config.get('languages');
			const inspected = config.inspect<string[]>(`languages.${languageId}.tokens.${tokenName}.exclusions`);
			const exclusions = (global ? inspected?.globalValue : inspected?.workspaceFolderValue) || [];
			if (!exclusions.includes(exclusion)) {
				exclusions.push(exclusion);
				try {			
					section[languageId].tokens[tokenName].exclusions = exclusions;
					await config.update('languages', section, global ? true : undefined);
				} catch (error) {
					console.log(error);
				}
			}
			return;
		}
}

export function deactivate() {}

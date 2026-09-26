import * as vscode from 'vscode'

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  vendor: string
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(
    'vidia.assistant',
    async (request, chatContext, response, token) => {
      const models = await vscode.lm.selectChatModels({ vendor })
      if (models.length === 0) {
        vscode.window.showErrorMessage('No VIDIA model selected. Add one in the Models Explorer (VIDIA panel).')
        return
      }
      // Slash command: /model switches which managed model is used.
      let model = models[0]
      if (request.command === 'model') {
        const picked = await vscode.window.showQuickPick(models.map(m => ({ label: m.name, model: m })),
          { placeHolder: 'Select a VIDIA model for @vidia chat' })
        if (!picked)  return
        model = picked.model
      }
      let prompt = request.prompt
      if (request.command === 'explain' || request.command === 'fix') {
        const editor = vscode.window.activeTextEditor
        let selection: string | undefined
        if (editor) {
          const range = editor.selection.isEmpty
            ? editor.document.getWordRangeAtPosition(editor.selection.start)
            : editor.selection
          selection = range ? editor.document.getText(range) : undefined
        }
        if (selection) {
          prompt = request.command === 'explain'
            ? `Explain this code:\n\n${selection}`
            : `Suggest a fix for this code:\n\n${selection}`
        }
      }
      if (chatContext.history.length > 0) {
        const history = chatContext.history.slice(-6).map(h =>
          h instanceof vscode.ChatRequestTurn
            ? `User: ${h.prompt}`
            : h instanceof vscode.ChatResponseTurn ? 'Assistant: (see above)' : ''
        ).join('\n')
        prompt = `Conversation so far:\n${history}\n\n${prompt}`
      }

      const messages = [vscode.LanguageModelChatMessage.User(prompt)]
      const chatResponse = await model.sendRequest(messages, {}, token)
      for await (const fragment of chatResponse.stream) {
        if (token.isCancellationRequested)  break
        if (fragment instanceof vscode.LanguageModelTextPart)
          response.markdown(fragment.value)

      }
    })
  participant.followupProvider = {
    provideFollowups(result: vscode.ChatResult, _ctx: vscode.ChatContext, _token: vscode.CancellationToken) {
      return [{
        prompt: 'Explain the selected code',
        command: 'explain'
      } satisfies vscode.ChatFollowup]
    }
  }
  context.subscriptions.push(participant)
  return participant
}

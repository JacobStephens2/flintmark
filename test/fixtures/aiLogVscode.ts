// Only AI log tests opt in to this VS Code host boundary.
export const logState = {
  enabled: false,
  lines: [] as string[],
  shown: false,
};

export const workspace = {
  getConfiguration: (section: string) => ({
    get: (key: string) => section === "ofm" && key === "ai.debugLog" && logState.enabled,
  }),
};

export const window = {
  createOutputChannel: () => ({
    appendLine: (line: string) => { logState.lines.push(line); },
    show: (preserveFocus: boolean) => { logState.shown = preserveFocus; },
  }),
};

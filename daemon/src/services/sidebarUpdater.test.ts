import { SidebarUpdater } from './sidebarUpdater.js';

function makeUpdater() {
  const cmux = {
    notificationCreate: jest.fn(async () => {}),
    notificationCreateForSurface: jest.fn(async () => {}),
    setStatus: jest.fn(async () => ''),
  };
  const exfClient = {
    listTasks: jest.fn(async () => ({
      data: {
        tasks: [],
      },
    })),
    listCalendarEvents: jest.fn(async () => ({
      data: {
        events: [],
      },
    })),
  };
  const agentManager = {
    getAllSessions: jest.fn(() => [
      {
        workspaceId: 'ws-1',
        surfaceId: 'surface-1',
        taskId: 'task-1',
        agentType: 'claude-code',
      },
    ]),
  };
  const workspaceManager = {
    getWorkspace: jest.fn(() => ({
      id: 'ws-1',
      surfaceId: 'surface-1',
    })),
    getDevServerWorkspaces: jest.fn(() => []),
    getAgentWorkspaces: jest.fn(() => []),
  };
  const config = {
    pollIntervalMs: 10000,
  };

  return {
    cmux,
    exfClient,
    updater: new SidebarUpdater(
      cmux as any,
      exfClient as any,
      agentManager as any,
      workspaceManager as any,
      config as any
    ),
  };
}

describe('SidebarUpdater external completion notices', () => {
  it('dedupes repeated missing-task notifications per workspace task pair', async () => {
    const { cmux, updater } = makeUpdater();

    await (updater as any).updateRemote();
    await (updater as any).updateRemote();

    expect(cmux.notificationCreateForSurface).toHaveBeenCalledTimes(1);
    expect(cmux.notificationCreateForSurface).toHaveBeenCalledWith(
      'surface-1',
      'Task completed externally',
      'Task for claude-code was completed outside this session'
    );
    expect(cmux.notificationCreate).not.toHaveBeenCalled();
  });
});

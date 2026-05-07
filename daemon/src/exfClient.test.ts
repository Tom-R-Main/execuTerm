import { ExfClient } from './exfClient.js';

describe('ExfClient work-item methods', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('sends typed work-item review requests with idempotency headers', async () => {
    const fetchMock: jest.Mock<Promise<any>, any[]> = jest.fn(async () => ({
      status: 200,
      json: async () => ({ workItem: { id: 'work-1', status: 'done' } }),
    }));
    global.fetch = fetchMock as any;
    const client = new ExfClient({
      apiUrl: 'https://api.example.test',
      pat: 'pat-test',
    });

    await client.completeWorkItem('work-1', {
      resultSummary: 'Approved from execuTerm dashboard.',
      artifactRefs: [{ type: 'branch', name: 'exf/agent/work-1/ws-1' }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/work-items/work-1/complete',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer pat-test',
          'Content-Type': 'application/json',
          'Idempotency-Key': expect.stringMatching(/^daemon-/),
        }),
        body: JSON.stringify({
          resultSummary: 'Approved from execuTerm dashboard.',
          artifactRefs: [{ type: 'branch', name: 'exf/agent/work-1/ws-1' }],
        }),
      })
    );
  });

  it('lists and fetches work items through the backend work queue API', async () => {
    const fetchMock: jest.Mock<Promise<any>, any[]> = jest.fn(async () => ({
      status: 200,
      json: async () => ({ workItems: [] }),
    }));
    global.fetch = fetchMock as any;
    const client = new ExfClient({
      apiUrl: 'https://api.example.test/',
      pat: 'pat-test',
    });

    await client.listWorkItems({
      status: 'needs_review',
      assignedAlias: 'codex',
      taskId: 'task-1',
      limit: 10,
    });
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ workItem: { id: 'work-1' } }),
    });
    await client.getWorkItem('work-1');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.example.test/api/v1/work-items?status=needs_review&assignedAlias=codex&taskId=task-1&limit=10',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.example.test/api/v1/work-items/work-1',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('appends durable work-item artifacts without changing status', async () => {
    const fetchMock: jest.Mock<Promise<any>, any[]> = jest.fn(async () => ({
      status: 200,
      json: async () => ({ workItem: { id: 'work-1', status: 'needs_review' } }),
    }));
    global.fetch = fetchMock as any;
    const client = new ExfClient({
      apiUrl: 'https://api.example.test',
      pat: 'pat-test',
    });

    await client.appendWorkItemArtifacts('work-1', [
      {
        type: 'verification_result',
        source: 'executerm',
        aggregateStatus: 'passed',
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/work-items/work-1/artifacts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          artifactRefs: [
            {
              type: 'verification_result',
              source: 'executerm',
              aggregateStatus: 'passed',
            },
          ],
        }),
      })
    );
  });
});

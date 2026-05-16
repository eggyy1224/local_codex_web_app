import type {
  PendingApprovalsResponse,
  PendingInteractionsResponse,
  ThreadContextResponse,
  ThreadDetailResponse,
  ThreadListItem,
  ThreadTimelineResponse,
} from "@lcwa/shared-types";

export type ThreadSnapshot = {
  data: ThreadDetailResponse;
  pending: PendingApprovalsResponse;
  pendingInteractionsResult: PendingInteractionsResponse;
  threadListResult: { data: ThreadListItem[] };
  timeline: ThreadTimelineResponse;
  context: ThreadContextResponse;
};

export async function fetchThreadSnapshot(
  gatewayUrl: string,
  threadId: string,
): Promise<ThreadSnapshot> {
  const [detailRes, approvalsRes, interactionsRes, threadsRes, timelineRes, contextRes] = await Promise.all([
    fetch(`${gatewayUrl}/api/threads/${threadId}?includeTurns=true`),
    fetch(`${gatewayUrl}/api/threads/${threadId}/approvals/pending`),
    fetch(`${gatewayUrl}/api/threads/${threadId}/interactions/pending`),
    fetch(`${gatewayUrl}/api/threads?limit=200`),
    fetch(`${gatewayUrl}/api/threads/${threadId}/timeline?limit=600`),
    fetch(`${gatewayUrl}/api/threads/${threadId}/context`),
  ]);

  if (!detailRes.ok) {
    throw new Error(`thread detail http ${detailRes.status}`);
  }
  if (!approvalsRes.ok) {
    throw new Error(`approvals http ${approvalsRes.status}`);
  }
  if (!interactionsRes.ok) {
    throw new Error(`interactions http ${interactionsRes.status}`);
  }
  if (!threadsRes.ok) {
    throw new Error(`thread list http ${threadsRes.status}`);
  }
  if (!timelineRes.ok) {
    throw new Error(`timeline http ${timelineRes.status}`);
  }
  if (!contextRes.ok) {
    throw new Error(`thread context http ${contextRes.status}`);
  }

  return {
    data: (await detailRes.json()) as ThreadDetailResponse,
    pending: (await approvalsRes.json()) as PendingApprovalsResponse,
    pendingInteractionsResult: (await interactionsRes.json()) as PendingInteractionsResponse,
    threadListResult: (await threadsRes.json()) as { data: ThreadListItem[] },
    timeline: (await timelineRes.json()) as ThreadTimelineResponse,
    context: (await contextRes.json()) as ThreadContextResponse,
  };
}

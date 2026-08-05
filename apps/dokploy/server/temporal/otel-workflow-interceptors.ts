import type {
	ActivityInput,
	Headers,
	LocalActivityInput,
	Next,
	WorkflowExecuteInput,
	WorkflowInboundCallsInterceptor,
	WorkflowInterceptorsFactory,
	WorkflowOutboundCallsInterceptor,
} from "@temporalio/workflow";

let workflowTraceHeaders: Headers = {};

class TraceContextInboundInterceptor
	implements WorkflowInboundCallsInterceptor
{
	async execute(
		input: WorkflowExecuteInput,
		next: Next<WorkflowInboundCallsInterceptor, "execute">,
	) {
		workflowTraceHeaders = input.headers;
		return next(input);
	}
}

class TraceContextOutboundInterceptor
	implements WorkflowOutboundCallsInterceptor
{
	scheduleActivity(
		input: ActivityInput,
		next: Next<WorkflowOutboundCallsInterceptor, "scheduleActivity">,
	) {
		return next({
			...input,
			headers: { ...workflowTraceHeaders, ...input.headers },
		});
	}

	scheduleLocalActivity(
		input: LocalActivityInput,
		next: Next<WorkflowOutboundCallsInterceptor, "scheduleLocalActivity">,
	) {
		return next({
			...input,
			headers: { ...workflowTraceHeaders, ...input.headers },
		});
	}
}

export const interceptors: WorkflowInterceptorsFactory = () => ({
	inbound: [new TraceContextInboundInterceptor()],
	outbound: [new TraceContextOutboundInterceptor()],
});

/**
 * modelSpy(): a counting WorkflowProvider (apps/service/src/workflow/provider.ts). Pass spy.provider wherever the service
 * takes a provider, run the flow, then expectNone(). "Connect, scan, assign, animate and open saved details make no model
 * call" is only worth claiming if a check like this fails when it stops being true.
 *
 * By default every call is recorded and then refused (rejected with ModelCallBlockedError), so a flow that reaches for a
 * model cannot spend anything even if a test forgets to look at the count. A test that legitimately needs an answer
 * (an explicit Process action, say) supplies canned responses. Calls are counted whatever the response, and the count is
 * the truth: code may catch the refusal, so a passing flow is one whose count is 0, not one that did not throw.
 *
 * Limits are the ones in ./index.ts: this sees the provider object it is handed. Code that builds its own provider or
 * uses fetch directly is caught by noNetwork(), and a child tool's own model traffic is not visible here at all.
 */
import type { ApiConnectionInput, WorkflowConnection } from '../../packages/contracts/src/workflow';
import type { ManagerRequest, ManagerResponse, WorkflowProvider } from '../../apps/service/src/workflow/provider';

export type ModelMethod = 'verify' | 'countInput' | 'summarize';

export interface ModelCall {
  method: ModelMethod;
  provider: string | null;
  model: string | null;
  /** The text handed to the model (countInput and summarize only). Never the API key. */
  input: string | null;
}

export class ModelCallBlockedError extends Error {
  readonly method: ModelMethod;
  constructor(method: ModelMethod) {
    super(`A test that expects no model call reached WorkflowProvider.${method}. Supply a canned response to modelSpy() if this call is intended.`);
    this.name = 'ModelCallBlockedError';
    this.method = method;
  }
}

export interface ModelSpyResponses {
  verify?: (input: ApiConnectionInput) => { models: string[] } | Promise<{ models: string[] }>;
  countInput?: (request: ManagerRequest) => number | Promise<number>;
  summarize?: (request: ManagerRequest) => ManagerResponse | Promise<ManagerResponse>;
}

export interface ModelSpy {
  /** Hand this to the code under test. */
  readonly provider: WorkflowProvider;
  readonly calls: readonly ModelCall[];
  /** Calls so far; pass a method to count only that one. */
  count(method?: ModelMethod): number;
  /** Paid inference calls only (summarize). Listing models and counting tokens are free but still refused by default. */
  readonly paidCount: number;
  /** Throws when any call was made, listing the methods. */
  expectNone(): void;
  reset(): void;
}

export function modelSpy(responses: ModelSpyResponses = {}): ModelSpy {
  const calls: ModelCall[] = [];
  const record = (call: ModelCall) => { calls.push(call); };
  const provider: WorkflowProvider = {
    async verify(input: ApiConnectionInput) {
      record({ method: 'verify', provider: input.provider, model: null, input: null });
      if (!responses.verify) throw new ModelCallBlockedError('verify');
      return responses.verify(input);
    },
    async countInput(connection: WorkflowConnection, _apiKey: string, request: ManagerRequest) {
      record({ method: 'countInput', provider: connection.provider, model: request.model, input: request.input });
      if (!responses.countInput) throw new ModelCallBlockedError('countInput');
      return responses.countInput(request);
    },
    async summarize(connection: WorkflowConnection, _apiKey: string, request: ManagerRequest) {
      record({ method: 'summarize', provider: connection.provider, model: request.model, input: request.input });
      if (!responses.summarize) throw new ModelCallBlockedError('summarize');
      return responses.summarize(request);
    },
  };
  return {
    provider,
    get calls() { return [...calls]; },
    count: method => method ? calls.filter(call => call.method === method).length : calls.length,
    get paidCount() { return calls.filter(call => call.method === 'summarize').length; },
    expectNone: () => {
      if (calls.length) throw new Error(`Expected no model provider call, but ${calls.length} were made: ${calls.map(call => call.method).join(', ')}`);
    },
    reset: () => { calls.length = 0; },
  };
}

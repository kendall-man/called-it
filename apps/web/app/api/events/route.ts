import { handleEntryEvent } from './handler';

export async function POST(request: Request): Promise<Response> {
  return handleEntryEvent(request);
}

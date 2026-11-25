import { SESSION_STORE, transact } from "./db";
import { EvaluationSession } from "./evaluation";

// ponytail: IndexedDB is intentionally local and quota-bound; migrate this
// adapter to Postgres + object storage when shared accounts are introduced.

export const saveSession = (session: EvaluationSession) =>
  transact(SESSION_STORE, "readwrite", (store) => store.put(session));

export const listSessions = async () => {
  const sessions = await transact<EvaluationSession[]>(
    SESSION_STORE,
    "readonly",
    (store) => store.getAll(),
  );
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

export const clearSessions = () =>
  transact(SESSION_STORE, "readwrite", (store) => store.clear());

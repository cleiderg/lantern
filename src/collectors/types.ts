// Shared types for Lantern collectors.

export type LogEntry = {
  timestamp: string; // ISO 8601
  message: string; // eventMessage text
  code_location: string; // subsystem:category or file:line — fingerprinting key
  severity: 'fault' | 'crash' | 'warning' | 'info';
};

export type LogQueryResult = { kind: 'entries'; entries: LogEntry[] } | { kind: 'no_data' }; // window exceeds retention or source unavailable

export interface LogSource {
  query(window: { start: string; end: string }): LogQueryResult;
}

export type Email = {
  id: string; // message-id — used as origin_ref for deduplication
  from: string;
  subject: string;
  body: string;
  date: string; // ISO 8601
  thread_id?: string;
};

export type EmailClassification = {
  is_bug: boolean;
  title: string;
  severity: 'fault' | 'crash' | 'warning' | 'info';
  repro_steps: string | null;
};

export type Classifier = (emails: Email[]) => EmailClassification[];

export interface InboxSource {
  fetch(since: string, until: string): Email[];
}

/** Per-source pattern that marks log messages as expected noise. */
export type NoisePattern = {
  source: 'logs' | 'inbox' | 'email' | 'ci';
  pattern: string;
};

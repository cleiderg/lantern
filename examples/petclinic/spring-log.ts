/**
 * Spring Boot console log lines → Lantern's plain-text log format (PetClinic trial).
 *
 *   Spring: 2026-10-03T18:41:00.001-07:00 ERROR 412 --- [petclinic] [nio-8080-exec-3] o.a.c.c.C.[.[.[/].[dispatcherServlet] : Servlet.service() … threw exception […]
 *   Lantern:   2026-10-03 18:41:00 [error] [o.a.c.c.C.../.dispatcherServlet] Servlet.service() … threw exception […]   (local time)
 *
 * `PlainTextLogSource` reads its timestamps as local time, so the converter
 * writes local time. Its component is `[...]`, so brackets in a logger name
 * are dropped. Stack frames, the banner and other non-log lines are dropped
 * and counted — the ERROR line itself already names the exception.
 *
 * As a pipe:  java -jar petclinic.jar 2>&1 | node examples/petclinic/spring-log.ts >> petclinic.log
 */

import { localStamp, pipeIfMain } from './log-convert.ts';

// <timestamp> <LEVEL> <pid> --- [app]? [thread] [correlation]? <logger> : <message>
const SPRING =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+\d+\s+---\s+(.*)$/;

/** One Spring Boot line → one Lantern plain line, or null when it is not a log line. */
export function convertSpringLine(line: string): string | null {
  const m = SPRING.exec(line.trim());
  if (!m) return null;
  const local = localStamp(m[1] as string);
  if (!local) return null;
  // Drop the leading [app] [thread] [correlation] groups; the logger is next.
  let rest = m[3] as string;
  while (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return null;
    rest = rest.slice(close + 1).trimStart();
  }
  const sep = rest.indexOf(' : ');
  if (sep < 0) return null;
  const logger = rest.slice(0, sep).trim().replace(/[[\]]/g, '');
  const message = rest.slice(sep + 3);
  return `${local} [${(m[2] as string).toLowerCase()}] [${logger}] ${message}`;
}

pipeIfMain(import.meta.url, 'spring-log', convertSpringLine);

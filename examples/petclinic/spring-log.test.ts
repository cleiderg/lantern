import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertSpringLine } from './spring-log.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const localOf = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const PLAIN = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] \[([^\]]+)\] (.*)$/;

test('convertSpringLine: Spring Boot console format → Lantern plain format, in local time', () => {
  const iso = '2026-10-03T18:40:12.345-07:00';
  assert.equal(
    convertSpringLine(
      `${iso}  INFO 41234 --- [petclinic] [           main] o.s.s.petclinic.PetClinicApplication     : Started PetClinicApplication in 3.1 seconds`,
    ),
    `${localOf(iso)} [info] [o.s.s.petclinic.PetClinicApplication] Started PetClinicApplication in 3.1 seconds`,
  );
});

test('convertSpringLine: a logger name with brackets still yields one parseable [component]', () => {
  const out = convertSpringLine(
    '2026-10-03T18:41:00.001Z ERROR 41234 --- [petclinic] [nio-8080-exec-3] [                                                 ] o.a.c.c.C.[.[.[/].[dispatcherServlet]    : Servlet.service() for servlet [dispatcherServlet] threw exception [Request processing failed: java.lang.RuntimeException: Expected: controller used to showcase what happens when an exception is thrown] with root cause',
  );
  const m = PLAIN.exec(out ?? '');
  assert.ok(m, out ?? 'null');
  assert.equal(m[2], 'error');
  assert.equal(m[3], 'o.a.c.c.C.../.dispatcherServlet');
  assert.match(m[4] as string, /^Servlet\.service\(\).*java\.lang\.RuntimeException: Expected/);
});

test('convertSpringLine: no app name, WARN level', () => {
  const out = convertSpringLine(
    '2026-10-03T18:42:00.000+00:00  WARN 7 --- [nio-8080-exec-1] .w.s.m.s.DefaultHandlerExceptionResolver : Resolved [org.springframework.web.method.annotation.MethodArgumentTypeMismatchException: x]',
  );
  assert.match(out ?? '', /\[warn\] \[\.w\.s\.m\.s\.DefaultHandlerExceptionResolver\] Resolved /);
});

test('convertSpringLine: stack frames, banners and blank lines are not log lines', () => {
  for (const line of [
    'java.lang.RuntimeException: Expected: controller used to showcase',
    '\tat org.springframework.samples.petclinic.system.CrashController.triggerException(CrashController.java:37)',
    '  .   ____          _            __ _ _',
    '',
  ]) {
    assert.equal(convertSpringLine(line), null, line);
  }
});

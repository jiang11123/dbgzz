import test from 'node:test';
import assert from 'node:assert/strict';
import { Video2xProgressParser } from './video-upscale';

test('streams real frame progress across split chunks without inventing completion', () => {
  const values: number[] = [];
  const parser = new Video2xProgressParser(value => values.push(value.percent));
  parser.push('\r\u001b[Kframe=18/');
  parser.push('100 (18.00%); fps=2.00; elapsed=00:00:09; remaining=00:00:41\r');
  parser.push('frame=100/100 (100.00%); fps=2.00; elapsed=00:00:50; remaining=00:00:00\r');
  assert.deepEqual(values, [18, 100]);
});
import { buildVideo2xArgs, makeUpscalePlan, targetResolution, validateEligiblePaths, isCompletedTeardownError, ProcessExitError } from './video-upscale';

test('maps 2K and 4K to long-edge targets while preserving portrait and landscape ratios', () => {
  assert.deepEqual(targetResolution({ width: 720, height: 960 }, '2k'), { width: 1920, height: 2560 });
  assert.deepEqual(targetResolution({ width: 1920, height: 1080 }, '4k'), { width: 3840, height: 2160 });
  assert.deepEqual(targetResolution({ width: 1080, height: 1080 }, '2k'), { width: 2560, height: 2560 });
  assert.throws(() => targetResolution({ width: 0, height: 1080 }, '2k'), /尺寸/);
});

test('creates a Real-ESRGAN 4x command with paths passed as arguments', () => {
  const plan = makeUpscalePlan('C:\\素材\\原片.mp4', '2k', { width: 720, height: 960 });
  assert.match(plan.outputPath, /超分视频\\原片-2K\.mp4$/);
  assert.deepEqual(buildVideo2xArgs(plan), ['-i', 'C:\\素材\\原片.mp4', '-o', plan.outputPath, '-p', 'realesrgan', '-s', '4', '--realesrgan-model', 'realesrgan-plus', '--max-b-frames', '0', '-e', 'crf=17']);
  assert.ok(!buildVideo2xArgs(plan).some((arg) => /[;&|`]/.test(arg)));
});

test('rejects invalid targets and never schedules a downscale', () => {
  assert.throws(() => targetResolution({ width: 1920, height: 1080 }, '8k' as any), /目标/);
  assert.throws(() => makeUpscalePlan('C:\\a.mp4', '2k', { width: 3840, height: 2160 }), /已达到/);
  assert.throws(() => targetResolution({ width: Infinity, height: 1080 }, '2k'), /尺寸/);
  const result = targetResolution({ width: 853, height: 480 }, '2k');
  assert.equal(result.width % 2, 0);
  assert.equal(result.height % 2, 0);
  assert.ok(Math.abs(result.width / result.height - 853 / 480) < 0.002);
});

test('accepts only videos already present in the library and deduplicates a batch', () => {
  const allowed = ['C:\\videos\\a.mp4', 'C:\\videos\\b.mov'];
  assert.deepEqual(validateEligiblePaths(['C:\\videos\\a.mp4', 'C:\\videos\\a.mp4', 'C:\\videos\\b.mov'], allowed), allowed);
  assert.throws(() => validateEligiblePaths(['C:\\windows\\anything.mp4'], allowed), /视频库/);
  assert.throws(() => validateEligiblePaths([], allowed), /至少/);
});

test('only recognizes the observed Windows teardown crash after all frames were reported', () => {
  const summary = 'Video processed successfully\nTotal frames processed: 24\n';
  assert.equal(isCompletedTeardownError(new ProcessExitError('video2x', 3221225477, summary, ''), 24), true);
  assert.equal(isCompletedTeardownError(new ProcessExitError('video2x', 3221225477, summary, ''), 25), false);
  assert.equal(isCompletedTeardownError(new ProcessExitError('video2x', 3221225477, 'Processing...', ''), 24), false);
  assert.equal(isCompletedTeardownError(new ProcessExitError('video2x', 1, summary, ''), 24), false);
  assert.equal(isCompletedTeardownError(new Error('spawn failed'), 24), false);
});

import test from 'node:test';
import { verifyControllerRuntime } from '../../packages/proprio-runner/scripts/controlled-evals/verify-runtime.mjs';

test('the uploaded controller preserves every inventoried runtime file', {
  skip: !process.env.PROPRIO_CONTROLLER_TRANSPORT_DIRECTORY,
}, async () => {
  await verifyControllerRuntime({
    directory: process.env.PROPRIO_CONTROLLER_TRANSPORT_DIRECTORY,
    sourceRevision: process.env.GITHUB_SHA,
    receiptSha256: process.env.PROPRIO_CONTROLLER_RECEIPT_SHA256,
  });
});

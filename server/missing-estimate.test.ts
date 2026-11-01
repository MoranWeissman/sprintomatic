import { describe, expect, it } from 'vitest';
import { missingEstimateRefusal } from './missing-estimate';

const NAME = '**Write the setup guide** (#100001)';

describe('missingEstimateRefusal', () => {
  it('stops a task with no estimate and asks for estimateHours', () => {
    const msg = missingEstimateRefusal({ displayName: NAME, type: 'Task', originalEstimate: undefined, estimateHours: undefined })!;
    expect(msg).toContain(NAME);
    expect(msg).toContain('estimateHours');
    expect(msg).toContain('Nothing was started');
  });

  it('treats a 0h estimate as missing', () => {
    expect(missingEstimateRefusal({ displayName: NAME, type: 'Task', originalEstimate: 0, estimateHours: 0 })).not.toBeNull();
  });

  it('lets the start through when the task has an estimate or one is passed', () => {
    expect(missingEstimateRefusal({ displayName: NAME, type: 'Task', originalEstimate: 3, estimateHours: undefined })).toBeNull();
    expect(missingEstimateRefusal({ displayName: NAME, type: 'Task', originalEstimate: null, estimateHours: 2 })).toBeNull();
  });

  it('never stops a bug', () => {
    expect(missingEstimateRefusal({ displayName: NAME, type: 'Bug', originalEstimate: undefined, estimateHours: undefined })).toBeNull();
  });
});

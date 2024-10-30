import React from 'react';

import { ColorPalette } from '../color.js';
import { AirplaneIcon } from '../icons/Airplane.js';
import { EnvelopeIcon } from '../icons/Envelope.js';
import { LockIcon } from '../icons/Lock.js';
import { ShieldIcon } from '../icons/Shield.js';
import { WideChevronIcon } from '../icons/WideChevron.js';

import { MessageStatus, MessageStage as Stage, StageTimings } from './types.js';

interface Props {
  status: MessageStatus;
  stage: Stage;
  timings: StageTimings;
  timestampSent?: number;
  hideDescriptions?: boolean;
}

export function MessageTimeline({
  status,
  stage: _stage,
  timings,
  timestampSent,
  hideDescriptions,
}: Props) {
  // Ignore stage value if status shows as delivered
  const stage = status === MessageStatus.Delivered ? Stage.Relayed : _stage;

  const timeSent = timestampSent ? new Date(timestampSent) : null;
  const timeSentStr = timeSent
    ? `${timeSent.toLocaleDateString()} ${timeSent.toLocaleTimeString()}`
    : null;

  return (
    <div className="htw-pt-14 htw-pb-1 htw-flex htw-w-full">
      <div className={styles.stageContainer}>
        <div
          className={`${styles.stageBar} htw-rounded-l ${getStageOpacityClass(
            Stage.Sent,
            stage,
            status,
          )}`}
        >
          <div className={styles.stageHole}></div>
          <div className={styles.stageIconContainer}>
            <StageIcon Icon={AirplaneIcon} />
            <div className={styles.stageIconCircle}></div>
          </div>
          <ChevronBlue />
        </div>
        <h4 className={styles.stageHeader}>
          {getStageHeader(Stage.Sent, stage, timings, status)}
        </h4>
        {!hideDescriptions && (
          <p className={styles.stageDesc}>
            {timeSentStr
              ? `Origin transaction sent at ${timeSentStr}`
              : 'Waiting for origin transaction'}
          </p>
        )}
      </div>
      <div className={styles.stageSpacer}></div>
      <div className={styles.stageContainer}>
        <div
          className={`${styles.stageBar} ${getStageOpacityClass(
            Stage.Finalized,
            stage,
            status,
          )}`}
        >
          <div className={styles.stageHole}></div>
          <div className={styles.stageIconContainer}>
            <StageIcon Icon={LockIcon} size={14} />
            <div className={styles.stageIconCircle}></div>
          </div>
          <ChevronWhite />
          <ChevronBlue />
        </div>
        <h4 className={styles.stageHeader}>
          {getStageHeader(Stage.Finalized, stage, timings, status)}
        </h4>
        {!hideDescriptions && (
          <p className={styles.stageDesc}>
            Origin transaction has sufficient confirmations
          </p>
        )}
      </div>
      <div className={styles.stageSpacer}></div>
      <div className={styles.stageContainer}>
        <div
          className={`${styles.stageBar} ${getStageOpacityClass(
            Stage.Validated,
            stage,
            status,
          )}`}
        >
          <div className={styles.stageHole}></div>
          <div className={styles.stageIconContainer}>
            <StageIcon Icon={ShieldIcon} />
            <div className={styles.stageIconCircle}></div>
          </div>
          <ChevronWhite />
          <ChevronBlue />
        </div>
        <h4 className={styles.stageHeader}>
          {getStageHeader(Stage.Validated, stage, timings, status)}
        </h4>
        {!hideDescriptions && (
          <p className={styles.stageDesc}>
            Validators have signed the message bundle
          </p>
        )}
      </div>
      <div className={styles.stageSpacer}></div>
      <div className={styles.stageContainer}>
        <div
          className={`${styles.stageBar} htw-rounded-r ${getStageOpacityClass(
            Stage.Relayed,
            stage,
            status,
          )}`}
        >
          <div className={styles.stageHole}></div>
          <div className={styles.stageIconContainer}>
            <StageIcon Icon={EnvelopeIcon} />
            <div className={styles.stageIconCircle}></div>
          </div>
          <ChevronWhite />
        </div>
        <h4 className={styles.stageHeader}>
          {getStageHeader(Stage.Relayed, stage, timings, status)}
        </h4>
        {!hideDescriptions && (
          <p className={styles.stageDesc}>
            Destination transaction has been confirmed
          </p>
        )}
      </div>
    </div>
  );
}

function StageIcon({ Icon, size }: { Icon: any; size?: number }) {
  return (
    <div className="htw-h-9 htw-w-9 htw-flex htw-items-center htw-justify-center htw-rounded-full htw-bg-blue-500">
      <Icon
        width={size ?? 14}
        height={size ?? 14}
        alt=""
        color={ColorPalette.White}
      />
    </div>
  );
}

function ChevronWhite() {
  return (
    <div className="htw-absolute htw--left-3 htw-top-0 htw-h-6">
      <WideChevronIcon
        direction="e"
        height="100%"
        width="auto"
        color="#ffffff"
      />
    </div>
  );
}

function ChevronBlue() {
  return (
    <div className="htw-absolute htw--right-3 htw-top-0 htw-h-6">
      <WideChevronIcon direction="e" height="100%" width="auto" />
    </div>
  );
}

function getStageHeader(
  targetStage: Stage,
  currentStage: Stage,
  timings: StageTimings,
  status: MessageStatus,
) {
  let label = '';
  if (targetStage === Stage.Finalized) {
    label = currentStage >= targetStage ? 'Finalized' : 'Finalizing';
  } else if (targetStage === Stage.Validated) {
    label = currentStage >= targetStage ? 'Validated' : 'Validating';
  } else if (targetStage === Stage.Relayed) {
    label = currentStage >= targetStage ? 'Relayed' : 'Relaying';
  } else if (targetStage === Stage.Sent) {
    label = currentStage >= targetStage ? 'Sent' : 'Sending';
  }
  const timing = timings[targetStage];
  if (status === MessageStatus.Failing) {
    if (targetStage === currentStage + 1) return `${label}: failed`;
    if (targetStage > currentStage + 1) return label;
  }
  if (timing) return `${label}: ${timing} sec`;
  else return label;
}

function getStageOpacityClass(
  targetStage: Stage,
  currentStage: Stage,
  messageStatus: MessageStatus,
) {
  if (currentStage >= targetStage) return '';
  if (
    currentStage === targetStage - 1 &&
    messageStatus !== MessageStatus.Failing
  )
    return 'htw-animate-pulse-slow';
  return 'htw-opacity-50';
}

const styles = {
  stageContainer: 'htw-flex-1 htw-flex htw-flex-col htw-items-center',
  stageSpacer: 'htw-flex-0 htw-w-1 xs:htw-w-2 sm:htw-w-3',
  stageBar:
    'htw-w-full htw-h-6 htw-flex htw-items-center htw-justify-center htw-bg-blue-500 htw-relative',
  stageHole: 'htw-w-3 htw-h-3 htw-rounded-full htw-bg-white',
  stageIconContainer:
    'htw-absolute htw--top-12 htw-flex htw-flex-col htw-items-center',
  stageIconCircle: 'htw-w-0.5 htw-h-4 htw-bg-blue-500',
  stageHeader:
    'htw-mt-2.5 htw-text-gray-700 htw-text-xs xs:htw-text-sm sm:htw-text-base',
  stageDesc:
    'htw-mt-1 sm:htw-px-4 htw-text-xs htw-text-gray-500 htw-text-center',
};

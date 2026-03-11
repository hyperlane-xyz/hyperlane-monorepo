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
  /** 'above' (default): icons float above the bar. 'inline': icons render inside the bar. */
  iconPosition?: 'above' | 'inline';
  /** Additional CSS class applied to each bar segment (useful for overriding the bar color). */
  barClassName?: string;
  /** Override the color of the chevron arrows between stages. */
  chevronColor?: string;
  /** Override the color of the stage icons. Defaults to white. */
  iconColor?: string;
}

export function MessageTimeline({
  status,
  stage: _stage,
  timings,
  timestampSent,
  hideDescriptions,
  iconPosition = 'above',
  barClassName,
  chevronColor,
  iconColor = ColorPalette.White,
}: Props) {
  // Ignore stage value if status shows as delivered
  const stage = status === MessageStatus.Delivered ? Stage.Relayed : _stage;
  const isInline = iconPosition === 'inline';

  const timeSent = timestampSent ? new Date(timestampSent) : null;
  const timeSentStr = timeSent
    ? `${timeSent.toLocaleDateString()} ${timeSent.toLocaleTimeString()}`
    : null;

  return (
    <div
      className={
        isInline
          ? 'htw-pb-1 htw-flex htw-w-full'
          : 'htw-pt-14 htw-pb-1 htw-flex htw-w-full'
      }
    >
      <div className={styles.stageContainer}>
        <div
          className={`${styles.stageBar} ${barClassName ?? ''} htw-rounded-l ${getStageOpacityClass(
            Stage.Sent,
            stage,
            status,
          )}`}
        >
          {isInline ? (
            <InlineIcon Icon={AirplaneIcon} color={iconColor} />
          ) : (
            <>
              <div className={styles.stageHole}></div>
              <div className={styles.stageIconContainer}>
                <StageIcon Icon={AirplaneIcon} />
                <div className={styles.stageIconCircle}></div>
              </div>
            </>
          )}
          <Chevron side="right" color={chevronColor} />
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
      <div
        className={isInline ? styles.stageSpacerInline : styles.stageSpacer}
      ></div>
      <div className={styles.stageContainer}>
        <div
          className={`${styles.stageBar} ${barClassName ?? ''} ${getStageOpacityClass(
            Stage.Finalized,
            stage,
            status,
          )}`}
        >
          {isInline ? (
            <InlineIcon Icon={LockIcon} size={14} color={iconColor} isMiddle />
          ) : (
            <>
              <div className={styles.stageHole}></div>
              <div className={styles.stageIconContainer}>
                <StageIcon Icon={LockIcon} size={14} />
                <div className={styles.stageIconCircle}></div>
              </div>
            </>
          )}
          <Chevron side="left" color={ColorPalette.White} />
          <Chevron side="right" color={chevronColor} />
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
      <div
        className={isInline ? styles.stageSpacerInline : styles.stageSpacer}
      ></div>
      <div className={styles.stageContainer}>
        <div
          className={`${styles.stageBar} ${barClassName ?? ''} ${getStageOpacityClass(
            Stage.Validated,
            stage,
            status,
          )}`}
        >
          {isInline ? (
            <InlineIcon Icon={ShieldIcon} color={iconColor} isMiddle />
          ) : (
            <>
              <div className={styles.stageHole}></div>
              <div className={styles.stageIconContainer}>
                <StageIcon Icon={ShieldIcon} />
                <div className={styles.stageIconCircle}></div>
              </div>
            </>
          )}
          <Chevron side="left" color={ColorPalette.White} />
          <Chevron side="right" color={chevronColor} />
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
      <div
        className={isInline ? styles.stageSpacerInline : styles.stageSpacer}
      ></div>
      <div className={styles.stageContainer}>
        <div
          className={`${styles.stageBar} ${barClassName ?? ''} htw-rounded-r ${getStageOpacityClass(
            Stage.Relayed,
            stage,
            status,
          )}`}
        >
          {isInline ? (
            <InlineIcon Icon={EnvelopeIcon} color={iconColor} />
          ) : (
            <>
              <div className={styles.stageHole}></div>
              <div className={styles.stageIconContainer}>
                <StageIcon Icon={EnvelopeIcon} />
                <div className={styles.stageIconCircle}></div>
              </div>
            </>
          )}
          <Chevron side="left" color={ColorPalette.White} />
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

type IconComponent = React.ComponentType<{
  width?: number;
  height?: number;
  color?: string;
  alt?: string;
}>;

function StageIcon({ Icon, size }: { Icon: IconComponent; size?: number }) {
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

function InlineIcon({
  Icon,
  size,
  color = ColorPalette.White,
  isMiddle,
}: {
  Icon: IconComponent;
  size?: number;
  color?: string;
  isMiddle?: boolean;
}) {
  return (
    <div
      className={`htw-flex htw-items-center htw-justify-center htw-z-10${isMiddle ? ' htw-pl-2' : ''}`}
    >
      <Icon width={size ?? 14} height={size ?? 14} color={color} />
    </div>
  );
}

function Chevron({
  side,
  color = ColorPalette.Blue,
}: {
  side: 'left' | 'right';
  color?: string;
}) {
  const posClass = side === 'left' ? 'htw--left-3' : 'htw--right-3';
  return (
    <div className={`htw-absolute ${posClass} htw-top-0 htw-h-6`}>
      <WideChevronIcon
        direction="e"
        height="100%"
        width="auto"
        color={color}
        style={{ display: 'block' }}
      />
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
  stageSpacerInline: 'htw-flex-0 htw-w-3',
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

/**
 * Gateway infrastructure failure codes merged into the shared Remote failure
 * vocabulary. Face-neutral: the Host face and the Client face each import this
 * module so both programs see the same map entries.
 */

/** Wire details every Gateway infrastructure failure carries. */
export interface TypertGatewayFaultDetails {
  /** Canonical `<namespace>/<method>` endpoint. */
  readonly endpoint: string
  /** Affected wire field when the failure is field-specific. */
  readonly field?: string
}

/** Wire details one downlink frame-size failure carries. */
export interface TypertGatewayDownlinkDetails {
  /** Logical stream whose downlink frame exceeded the mux's byte cap. */
  readonly streamId: string
}

/** Wire details one refused downlink resume carries. */
export interface TypertGatewayResyncDetails {
  /** Logical stream the Client asked to resume. */
  readonly streamId: string
  /** First item sequence number the Client asked to resume from. */
  readonly resumeFromSeq: number
}

/**
 * Failure code for one downlink frame the mux refused to write: the encoded
 * frame exceeded its byte cap. The logical stream fails; the socket stays open,
 * because an oversized item is no defect of the carrier.
 */
export const REMOTE_STREAM_FRAME_TOO_LARGE = 'gateway/downlink-frame-too-large'

/**
 * Failure code for one resume request the mux cannot serve without a gap: the
 * items after the Client's sequence number are not (or no longer) retained, or
 * the Client claims items the stream never produced. The logical stream ends
 * with this terminal frame, and the Client must open it fresh — the Host does
 * not keep the producer of a disconnected stream alive.
 */
export const REMOTE_STREAM_RESYNC_UNAVAILABLE = 'gateway/downlink-resync-unavailable'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'gateway/ambiguous-endpoint': TypertGatewayFaultDetails
    'gateway/arguments-invalid': TypertGatewayFaultDetails
    'gateway/binding-invalid': TypertGatewayFaultDetails
    'gateway/context-failed': TypertGatewayFaultDetails
    'gateway/context-not-found': TypertGatewayFaultDetails
    'gateway/context-unavailable': TypertGatewayFaultDetails
    'gateway/definition-unavailable': TypertGatewayFaultDetails
    'gateway/downlink-frame-too-large': TypertGatewayDownlinkDetails
    'gateway/downlink-resync-unavailable': TypertGatewayResyncDetails
    'gateway/input-invalid': TypertGatewayFaultDetails
    'gateway/invocation-unavailable': TypertGatewayFaultDetails
    'gateway/lookup-failed': TypertGatewayFaultDetails
    'gateway/lookup-not-found': TypertGatewayFaultDetails
    'gateway/lookup-unavailable': TypertGatewayFaultDetails
    'gateway/method-unavailable': TypertGatewayFaultDetails
    'gateway/protocol': TypertGatewayFaultDetails
    'gateway/provider-mismatch': TypertGatewayFaultDetails
    'gateway/result-invalid': TypertGatewayFaultDetails
    'gateway/service-unavailable': TypertGatewayFaultDetails
    'gateway/signature-invalid': TypertGatewayFaultDetails
    'gateway/uplink-overflow': TypertGatewayFaultDetails
  }
}

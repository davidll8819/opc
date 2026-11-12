import { AppException } from '@yikart/common'

// Thrown only by local validation before dispatching to any generation service.
// Unknown transport/provider errors must never use this type.
export class VideoPreflightException extends AppException {}

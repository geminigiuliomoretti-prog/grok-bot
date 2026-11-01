export interface ScreenDimensions {
  width: number;
  height: number;
}

export interface NormalizedCoordinate {
  x: number; // 0 - 1000
  y: number; // 0 - 1000
}

export interface PixelCoordinate {
  x: number;
  y: number;
}

export interface ScaledImageResult {
  base64: string;
  originalDimensions: ScreenDimensions;
  scaledDimensions: ScreenDimensions;
  scaleX: number;
  scaleY: number;
}

// Surface Pro 9 default screen specifications
export const SURFACE_PRO_9_NATIVE: ScreenDimensions = {
  width: 2880,
  height: 1920,
};

// Agent virtual desktop default dimensions
export const AGENT_DESKTOP_DEFAULT: ScreenDimensions = {
  width: 1280,
  height: 800,
};

export class CoordinateNormalizer {
  private readonly targetScreen: ScreenDimensions;

  constructor(targetScreen: ScreenDimensions = AGENT_DESKTOP_DEFAULT) {
    this.targetScreen = targetScreen;
  }

  /**
   * Converts real pixel coordinates to normalized 0-1000 scale expected by Gemini / Gemma Computer Use.
   */
  normalize(
    coord: PixelCoordinate,
    source: ScreenDimensions = this.targetScreen,
  ): NormalizedCoordinate {
    const safeW = Math.max(1, source.width);
    const safeH = Math.max(1, source.height);

    const normX = Math.round((Math.max(0, Math.min(source.width, coord.x)) / safeW) * 1000);
    const normY = Math.round((Math.max(0, Math.min(source.height, coord.y)) / safeH) * 1000);

    return {
      x: Math.max(0, Math.min(1000, normX)),
      y: Math.max(0, Math.min(1000, normY)),
    };
  }

  /**
   * Converts model normalized coordinates (0-1000) or raw coordinates into target pixel coordinates.
   */
  denormalize(
    coord: { x: number; y: number },
    target: ScreenDimensions = this.targetScreen,
  ): PixelCoordinate {
    const rawX = typeof coord.x === "number" ? coord.x : Number.parseFloat(String(coord.x)) || 0;
    const rawY = typeof coord.y === "number" ? coord.y : Number.parseFloat(String(coord.y)) || 0;

    // Detect if coordinate is already in target pixel space (e.g. > 1000 or within target aspect while > 1000)
    if (rawX > 1000 || rawY > 1000) {
      return {
        x: Math.round(Math.max(0, Math.min(target.width, rawX))),
        y: Math.round(Math.max(0, Math.min(target.height, rawY))),
      };
    }

    // Standard 0 - 1000 normalized input
    const realX = Math.round((rawX / 1000) * target.width);
    const realY = Math.round((rawY / 1000) * target.height);

    return {
      x: Math.max(0, Math.min(target.width, realX)),
      y: Math.max(0, Math.min(target.height, realY)),
    };
  }

  /**
   * Pre-processes screenshot metadata without invoking heavy native C++ image modules,
   * extracting PNG dimensions directly from PNG IHDR chunk (header).
   */
  extractPngDimensions(buffer: Buffer): ScreenDimensions | null {
    if (buffer.length < 24) return null;
    // Check PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] !== 0x89 ||
      buffer[1] !== 0x50 ||
      buffer[2] !== 0x4e ||
      buffer[3] !== 0x47
    ) {
      return null;
    }

    // IHDR chunk starts at offset 12; width is at 16 (4 bytes big-endian), height is at 20 (4 bytes big-endian)
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);

    if (width > 0 && height > 0) {
      return { width, height };
    }
    return null;
  }

  /**
   * Prepares a screenshot payload for Computer Use inference, calculating scale ratios.
   */
  prepareScreenshotPayload(
    base64Data: string,
    targetBounds: ScreenDimensions = this.targetScreen,
  ): ScaledImageResult {
    const cleanBase64 = base64Data.replace(/^data:image\/[a-z]+;base64,/, "");
    const buf = Buffer.from(cleanBase64, "base64");
    const extracted = this.extractPngDimensions(buf) ?? targetBounds;

    const scaleX = targetBounds.width / extracted.width;
    const scaleY = targetBounds.height / extracted.height;

    return {
      base64: cleanBase64,
      originalDimensions: extracted,
      scaledDimensions: targetBounds,
      scaleX,
      scaleY,
    };
  }
}

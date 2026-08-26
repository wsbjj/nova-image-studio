import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getNovaTaskMock = vi.hoisted(() => vi.fn());
const ackNovaTaskMock = vi.hoisted(() => vi.fn());
const uploadImageMock = vi.hoisted(() => vi.fn());
const fetchImageAsBlobMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ccode-task-client", () => ({
  getNovaTask: getNovaTaskMock,
  ackNovaTask: ackNovaTaskMock,
}));

vi.mock("../lib/image-storage", () => ({
  uploadImage: uploadImageMock,
}));

vi.mock("@/lib/image-downloader", () => ({
  fetchImageAsBlob: fetchImageAsBlobMock,
}));

import { pollNodeTask } from "../canvas-generation-service";

const completedTask = {
  id: "task-1",
  status: "completed",
  result: { images: ["URL:/api/nova/images/task-1/0"] },
};

const storedImage = {
  storageKey: "image:1",
  url: "blob:image-1",
  width: 1024,
  height: 1024,
  mimeType: "image/png",
  bytes: 128,
};

describe("canvas generation result caching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getNovaTaskMock.mockReset().mockResolvedValue(completedTask);
    ackNovaTaskMock.mockReset().mockResolvedValue(undefined);
    uploadImageMock.mockReset().mockResolvedValue(storedImage);
    fetchImageAsBlobMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries a temporarily unavailable completed image before acknowledging the task", async () => {
    const blob = new Blob(["image"], { type: "image/png" });
    fetchImageAsBlobMock.mockResolvedValue(blob);

    const result = await pollNodeTask("task-1", vi.fn());

    expect(result).toEqual([expect.objectContaining({ cacheStatus: "cached", storageKey: "image:1", url: "blob:image-1" })]);
    expect(fetchImageAsBlobMock).toHaveBeenCalledWith("/api/nova/images/task-1/0", 3);
    expect(uploadImageMock).toHaveBeenCalledWith(blob);
    expect(ackNovaTaskMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the remote image available and does not acknowledge when local caching exhausts its retries", async () => {
    fetchImageAsBlobMock.mockRejectedValue(new Error("HTTP 503"));

    const result = await pollNodeTask("task-1", vi.fn());

    expect(result).toEqual([
      expect.objectContaining({
        cacheStatus: "pending",
        remoteUrl: "/api/nova/images/task-1/0",
        url: "/api/nova/images/task-1/0",
      }),
    ]);
    expect(fetchImageAsBlobMock).toHaveBeenCalledWith("/api/nova/images/task-1/0", 3);
    expect(ackNovaTaskMock).not.toHaveBeenCalled();
  });
});

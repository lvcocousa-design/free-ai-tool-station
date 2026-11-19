'use strict';
/**
 * lib/kaggle-kernels.js — Kaggle kernel Python 代码模板。
 *
 * 两个 kernel 都以 .py 脚本形式提交（push 时 kernelType=script），在 Kaggle
 * GPU 机器上跑 ComfyUI：
 *   - FLUX：Comfy-Org/Flux-1-Schnell 的 flux1-schnell-fp8.safetensors，
 *     1024x1024、4 步、euler、cfg 1.0、seed 42，成品 /kaggle/working/output.png。
 *   - Wan：Comfy-Org/Wan-2.2 的三个文件（diffusion_models/wan2.2_ti2v_5B_fp16、
 *     vae/wan2.2_vae、text_encoders/umt5_xxl_fp8_e4m3fn_scaled——必须是
 *     Comfy-Org 打包的 FP8 文本编码器，官方 Wan 文本编码器 ComfyUI 不认），
 *     WanImageToVideo 1280x704、121 帧、20 步、cfg 5.0、euler、
 *     ModelSamplingSD3 shift 8.0；SaveVideo 节点经 API 会失败，改用
 *     SaveImage 出 PNG 帧再用 OpenCV 合成 mp4，成品 /kaggle/working/output.mp4。
 *
 * 注入方式：提示词和首帧都以 base64 嵌进代码、kernel 内解码。这样提示词里的
 * 引号、换行、反斜杠、emoji 等任何字符都不会破坏 Python 字符串字面量。
 *
 * 磁盘布局：ComfyUI 装在 /tmp/ComfyUI（不进 /kaggle/working，避免模型和源码
 * 被 Kaggle 当成 kernel 输出文件、淹没 output 列表）；只有成品和 comfyui.log
 * 写进 /kaggle/working。
 */

function b64encodeUtf8(str) {
  return Buffer.from(String(str), 'utf8').toString('base64');
}

function stripDataUrlPrefix(b64) {
  return String(b64).replace(/^data:[^;]+;base64,/, '');
}

const FLUX_KERNEL_TEMPLATE = `# Free AI Tool Station - FLUX.1 schnell (FP8) image kernel.
# Runs ComfyUI on Kaggle GPU: 1024x1024, 4 steps, euler, cfg 1.0, seed 42.
# Output: /kaggle/working/output.png
import base64
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

PROMPT = base64.b64decode("__PROMPT_B64__").decode("utf-8")

COMFY_DIR = "/tmp/ComfyUI"
COMFY_PORT = 8188
WORKING_DIR = "/kaggle/working"
OUT_PATH = os.path.join(WORKING_DIR, "output.png")
CHECKPOINT_URL = "https://huggingface.co/Comfy-Org/Flux-1-Schnell/resolve/main/flux1-schnell-fp8.safetensors"
CHECKPOINT_NAME = "flux1-schnell-fp8.safetensors"


def log(msg):
    print("[flux] " + str(msg), flush=True)


def run(cmd, cwd=None):
    log("$ " + " ".join(cmd))
    proc = subprocess.run(cmd, cwd=cwd)
    if proc.returncode != 0:
        raise RuntimeError("command failed (%s): %s" % (proc.returncode, " ".join(cmd)))


def download(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        log("exists, skip: " + dest)
        return
    log("downloading " + url)
    req = urllib.request.Request(url, headers={"User-Agent": "free-ai-tool-station"})
    with urllib.request.urlopen(req) as resp, open(dest, "wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(8 * 1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                log("  %d / %d MB" % (done // 1024 // 1024, total // 1024 // 1024))
    log("saved %s (%d bytes)" % (dest, os.path.getsize(dest)))


def install_comfyui():
    if not os.path.isdir(COMFY_DIR):
        run(["git", "clone", "--depth", "1",
             "https://github.com/comfyanonymous/ComfyUI.git", COMFY_DIR])
    run([sys.executable, "-m", "pip", "install", "-q", "-r",
         os.path.join(COMFY_DIR, "requirements.txt")])


def start_comfyui():
    log_path = os.path.join(WORKING_DIR, "comfyui.log")
    log_file = open(log_path, "wb")
    proc = subprocess.Popen(
        [sys.executable, "main.py", "--listen", "127.0.0.1",
         "--port", str(COMFY_PORT)],
        cwd=COMFY_DIR, stdout=log_file, stderr=subprocess.STDOUT)
    base = "http://127.0.0.1:%d" % COMFY_PORT
    for _ in range(120):
        try:
            with urllib.request.urlopen(base + "/", timeout=5) as resp:
                if resp.status == 200:
                    log("ComfyUI is up")
                    return proc, base
        except Exception:
            pass
        time.sleep(5)
    proc.kill()
    raise RuntimeError("ComfyUI did not start in time (see comfyui.log)")


def api_post_json(base, path, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(base + path, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_get_json(base, path):
    with urllib.request.urlopen(base + path, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_prompt_done(base, prompt_id, timeout_s=3600):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        hist = api_get_json(base, "/history/%s" % prompt_id)
        if prompt_id in hist:
            return hist[prompt_id]
        time.sleep(5)
    raise RuntimeError("timed out waiting for ComfyUI prompt " + prompt_id)


def output_disk_path(image):
    # ComfyUI writes node outputs under <ComfyUI>/output/<subfolder>/<filename>.
    parts = [COMFY_DIR, "output"]
    if image.get("subfolder"):
        parts.append(image["subfolder"])
    parts.append(image["filename"])
    return os.path.join(*parts)


def build_workflow(prompt):
    return {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": CHECKPOINT_NAME}},
        "2": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["1", 1]}},
        "3": {"class_type": "EmptyLatentImage",
              "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
        "4": {"class_type": "KSampler",
              "inputs": {"seed": 42, "steps": 4, "cfg": 1.0,
                         "sampler_name": "euler", "scheduler": "simple",
                         "denoise": 1.0, "model": ["1", 0],
                         "positive": ["2", 0], "negative": ["2", 0],
                         "latent_image": ["3", 0]}},
        "5": {"class_type": "VAEDecode",
              "inputs": {"samples": ["4", 0], "vae": ["1", 2]}},
        "6": {"class_type": "SaveImage",
              "inputs": {"filename_prefix": "output", "images": ["5", 0]}},
    }


def main():
    log("prompt: " + PROMPT)
    install_comfyui()
    download(CHECKPOINT_URL,
             os.path.join(COMFY_DIR, "models", "checkpoints", CHECKPOINT_NAME))
    proc, base = start_comfyui()
    try:
        result = api_post_json(base, "/prompt", {"prompt": build_workflow(PROMPT)})
        if result.get("node_errors"):
            raise RuntimeError("ComfyUI rejected workflow: " + json.dumps(result["node_errors"]))
        prompt_id = result["prompt_id"]
        log("prompt_id=" + prompt_id)
        entry = wait_prompt_done(base, prompt_id)
        status = entry.get("status", {})
        if status.get("status_str") == "error":
            raise RuntimeError("ComfyUI error: " + json.dumps(status))
        images = entry["outputs"]["6"]["images"]
        src = output_disk_path(images[0])
        shutil.copyfile(src, OUT_PATH)
        log("wrote %s (%d bytes)" % (OUT_PATH, os.path.getsize(OUT_PATH)))
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
`;

const WAN_KERNEL_TEMPLATE = `# Free AI Tool Station - Wan 2.2 TI2V-5B image-to-video kernel.
# Runs ComfyUI on Kaggle GPU: 1280x704, 121 frames, 20 steps, cfg 5.0, euler,
# ModelSamplingSD3 shift 8.0. SaveVideo fails via the API, so frames are saved
# as PNGs (SaveImage) and muxed into mp4 with OpenCV.
# Output: /kaggle/working/output.mp4
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

FIRST_FRAME_B64 = "__FIRST_FRAME_B64__"
PROMPT = base64.b64decode("__PROMPT_B64__").decode("utf-8")

COMFY_DIR = "/tmp/ComfyUI"
COMFY_PORT = 8188
WORKING_DIR = "/kaggle/working"
OUT_PATH = os.path.join(WORKING_DIR, "output.mp4")
FIRST_FRAME_NAME = "first_frame.jpg"
UNET_URL = "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors"
UNET_NAME = "wan2.2_ti2v_5B_fp16.safetensors"
VAE_URL = "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/vae/wan2.2_vae.safetensors"
VAE_NAME = "wan2.2_vae.safetensors"
# Must be the Comfy-Org packaged FP8 text encoder; the official Wan text
# encoder is not recognised by ComfyUI.
CLIP_URL = "https://huggingface.co/Comfy-Org/Wan-2.2/resolve/main/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
CLIP_NAME = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"


def log(msg):
    print("[wan] " + str(msg), flush=True)


def run(cmd, cwd=None):
    log("$ " + " ".join(cmd))
    proc = subprocess.run(cmd, cwd=cwd)
    if proc.returncode != 0:
        raise RuntimeError("command failed (%s): %s" % (proc.returncode, " ".join(cmd)))


def download(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        log("exists, skip: " + dest)
        return
    log("downloading " + url)
    req = urllib.request.Request(url, headers={"User-Agent": "free-ai-tool-station"})
    with urllib.request.urlopen(req) as resp, open(dest, "wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(8 * 1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                log("  %d / %d MB" % (done // 1024 // 1024, total // 1024 // 1024))
    log("saved %s (%d bytes)" % (dest, os.path.getsize(dest)))


def install_comfyui():
    if not os.path.isdir(COMFY_DIR):
        run(["git", "clone", "--depth", "1",
             "https://github.com/comfyanonymous/ComfyUI.git", COMFY_DIR])
    run([sys.executable, "-m", "pip", "install", "-q", "-r",
         os.path.join(COMFY_DIR, "requirements.txt")])
    # Needed to mux the PNG frames into an mp4 (SaveVideo fails via the API).
    run([sys.executable, "-m", "pip", "install", "-q", "opencv-python-headless"])


def write_first_frame():
    path = os.path.join(COMFY_DIR, "input", FIRST_FRAME_NAME)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(base64.b64decode(FIRST_FRAME_B64))
    log("wrote first frame %s (%d bytes)" % (path, os.path.getsize(path)))


def start_comfyui():
    log_path = os.path.join(WORKING_DIR, "comfyui.log")
    log_file = open(log_path, "wb")
    proc = subprocess.Popen(
        [sys.executable, "main.py", "--listen", "127.0.0.1",
         "--port", str(COMFY_PORT)],
        cwd=COMFY_DIR, stdout=log_file, stderr=subprocess.STDOUT)
    base = "http://127.0.0.1:%d" % COMFY_PORT
    for _ in range(120):
        try:
            with urllib.request.urlopen(base + "/", timeout=5) as resp:
                if resp.status == 200:
                    log("ComfyUI is up")
                    return proc, base
        except Exception:
            pass
        time.sleep(5)
    proc.kill()
    raise RuntimeError("ComfyUI did not start in time (see comfyui.log)")


def api_post_json(base, path, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(base + path, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_get_json(base, path):
    with urllib.request.urlopen(base + path, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_prompt_done(base, prompt_id, timeout_s=3 * 3600):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        hist = api_get_json(base, "/history/%s" % prompt_id)
        if prompt_id in hist:
            return hist[prompt_id]
        time.sleep(10)
    raise RuntimeError("timed out waiting for ComfyUI prompt " + prompt_id)


def output_disk_path(image):
    # ComfyUI writes node outputs under <ComfyUI>/output/<subfolder>/<filename>.
    parts = [COMFY_DIR, "output"]
    if image.get("subfolder"):
        parts.append(image["subfolder"])
    parts.append(image["filename"])
    return os.path.join(*parts)


def build_workflow(prompt):
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": UNET_NAME, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": CLIP_NAME, "type": "wan"}},
        "3": {"class_type": "VAELoader",
              "inputs": {"vae_name": VAE_NAME}},
        "4": {"class_type": "LoadImage",
              "inputs": {"image": FIRST_FRAME_NAME}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["2", 0]}},
        "6": {"class_type": "CLIPTextEncode",
              "inputs": {"text": "", "clip": ["2", 0]}},
        "7": {"class_type": "WanImageToVideo",
              "inputs": {"positive": ["5", 0], "negative": ["6", 0],
                         "vae": ["3", 0], "width": 1280, "height": 704,
                         "length": 121, "batch_size": 1, "image": ["4", 0]}},
        "8": {"class_type": "ModelSamplingSD3",
              "inputs": {"model": ["1", 0], "shift": 8.0}},
        "9": {"class_type": "KSampler",
              "inputs": {"seed": 42, "steps": 20, "cfg": 5.0,
                         "sampler_name": "euler", "scheduler": "simple",
                         "denoise": 1.0, "model": ["8", 0],
                         "positive": ["5", 0], "negative": ["6", 0],
                         "latent_image": ["7", 0]}},
        "10": {"class_type": "VAEDecode",
               "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
        "11": {"class_type": "SaveImage",
               "inputs": {"filename_prefix": "frame", "images": ["10", 0]}},
    }


def assemble_video(images, out_path, fps=24):
    import cv2
    paths = sorted(output_disk_path(img) for img in images)
    frames = []
    for p in paths:
        frame = cv2.imread(p, cv2.IMREAD_COLOR)
        if frame is None:
            raise RuntimeError("failed to decode frame: " + p)
        frames.append(frame)
    h, w = frames[0].shape[:2]
    writer = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for frame in frames:
        writer.write(frame)
    writer.release()
    log("wrote %s (%d frames, %d bytes)" % (out_path, len(frames), os.path.getsize(out_path)))


def main():
    log("prompt: " + PROMPT)
    install_comfyui()
    write_first_frame()
    download(UNET_URL,
             os.path.join(COMFY_DIR, "models", "diffusion_models", UNET_NAME))
    download(VAE_URL,
             os.path.join(COMFY_DIR, "models", "vae", VAE_NAME))
    download(CLIP_URL,
             os.path.join(COMFY_DIR, "models", "text_encoders", CLIP_NAME))
    proc, base = start_comfyui()
    try:
        result = api_post_json(base, "/prompt", {"prompt": build_workflow(PROMPT)})
        if result.get("node_errors"):
            raise RuntimeError("ComfyUI rejected workflow: " + json.dumps(result["node_errors"]))
        prompt_id = result["prompt_id"]
        log("prompt_id=" + prompt_id)
        entry = wait_prompt_done(base, prompt_id)
        status = entry.get("status", {})
        if status.get("status_str") == "error":
            raise RuntimeError("ComfyUI error: " + json.dumps(status))
        images = entry["outputs"]["11"]["images"]
        assemble_video(images, OUT_PATH)
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
`;

/**
 * 生成 FLUX 出图 kernel 的完整 Python 代码。
 * @param {object} params
 * @param {string} params.prompt - 出图提示词（以 base64 注入，任意字符都安全）
 * @returns {string} 完整的 kernel Python 代码
 */
function buildFluxKernelCode({ prompt }) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('buildFluxKernelCode: prompt 不能为空');
  }
  return FLUX_KERNEL_TEMPLATE.replace('__PROMPT_B64__', b64encodeUtf8(prompt));
}

/**
 * 生成 Wan 图生视频 kernel 的完整 Python 代码。
 * @param {object} params
 * @param {string} params.firstFrameBase64 - 首帧图片 base64（可带 data: 前缀）
 * @param {string} params.prompt - 动作描述提示词（以 base64 注入）
 * @returns {string} 完整的 kernel Python 代码
 */
function buildWanKernelCode({ firstFrameBase64, prompt }) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('buildWanKernelCode: prompt 不能为空');
  }
  if (!firstFrameBase64 || !String(firstFrameBase64).trim()) {
    throw new Error('buildWanKernelCode: firstFrameBase64 不能为空');
  }
  return WAN_KERNEL_TEMPLATE
    .replace('__FIRST_FRAME_B64__', stripDataUrlPrefix(firstFrameBase64))
    .replace('__PROMPT_B64__', b64encodeUtf8(prompt));
}

module.exports = { buildFluxKernelCode, buildWanKernelCode };

"use strict";

const TRACK_URL = "DanceWithSteelBallRun.mp3";
const TARGET_ANALYSIS_RATE = 11025;
const MIN_BPM = 60;
const MAX_BPM = 200;
const TEMPO_WINDOW_SECONDS = 24;
const TEMPO_HOP_SECONDS = 8;
const SCHEDULER_INTERVAL_MS = 25;
const SCHEDULER_LOOKAHEAD_SECONDS = 0.07;

const state = {
  audioContext: null,
  decodedBuffer: null,
  analysis: null,
  analysisStarted: false,
  analysisSourceName: TRACK_URL,
  animationFrameId: null,
  schedulerId: null,
  isDraggingProgress: false,
  lastVisualBeatKey: null,
  scheduledBeatKeys: new Set(),
  activeObjectUrl: null,
  resizeTimer: null
};

const ui = {};

window.addEventListener("DOMContentLoaded", initialize);

function initialize() {
  cacheUi();
  bindEvents();
  updateTransport();
  updatePlaybackUi();
  startAnimationLoop();

  // Start analysis immediately. If the page is opened through file:// and the
  // browser blocks fetch(), the manual file picker remains available.
  analyzeTrackFromUrl(TRACK_URL).catch((error) => {
    console.error(error);
    setAnalysisStatus(
      "Automatic analysis could not load the MP3. Use a local web server or choose the MP3 manually.",
      "error"
    );
  });
}

function cacheUi() {
  const ids = [
    "song",
    "playPauseButton",
    "rewindButton",
    "forwardButton",
    "filePicker",
    "trackTitle",
    "timeDisplay",
    "progressBar",
    "progressFill",
    "progressMarkers",
    "playbackStatus",
    "analysisStatus",
    "analysisProgressFill",
    "overallBpm",
    "overallBpmConfidence",
    "overallMeter",
    "overallMeterConfidence",
    "currentBpm",
    "currentRegion",
    "currentMeter",
    "currentMeterConfidence",
    "metronomeOrb",
    "beatNumber",
    "barNumber",
    "beatTime",
    "nextBeatTime",
    "beatPhaseFill",
    "audibleMetronome",
    "syncMessage",
    "analysisTimeline",
    "analysisCanvas",
    "analysisPlayhead",
    "regionTableBody",
    "changeTableBody"
  ];

  for (const id of ids) {
    ui[id] = document.getElementById(id);
  }
}

function bindEvents() {
  ui.song.addEventListener("loadedmetadata", () => {
    updateTransport();
    setPlaybackStatus("Ready");
  });

  ui.song.addEventListener("canplay", () => {
    ui.playPauseButton.disabled = false;
    ui.rewindButton.disabled = false;
    ui.forwardButton.disabled = false;
  });

  ui.song.addEventListener("play", () => {
    ui.playPauseButton.textContent = "Pause";
    setPlaybackStatus("Playing", "success");
    resetMetronomeSynchronization();
    startMetronomeScheduler();
  });

  ui.song.addEventListener("pause", () => {
    ui.playPauseButton.textContent = "Play";
    setPlaybackStatus(ui.song.ended ? "Finished" : "Paused");
    stopMetronomeScheduler();
    resetMetronomeSynchronization();
  });

  ui.song.addEventListener("ended", () => {
    ui.playPauseButton.textContent = "Play";
    setPlaybackStatus("Finished");
    stopMetronomeScheduler();
    resetMetronomeSynchronization();
  });

  ui.song.addEventListener("waiting", () => setPlaybackStatus("Buffering…"));
  ui.song.addEventListener("playing", () => setPlaybackStatus("Playing", "success"));

  ui.song.addEventListener("error", () => {
    ui.playPauseButton.disabled = true;
    setPlaybackStatus(
      "Could not load DanceWithSteelBallRun.mp3. Confirm it is beside the HTML file.",
      "error"
    );
  });

  ui.song.addEventListener("seeking", () => {
    stopMetronomeScheduler();
    resetMetronomeSynchronization();
    ui.syncMessage.textContent = "Seeking; metronome clock is being recalculated.";
  });

  ui.song.addEventListener("seeked", () => {
    resetMetronomeSynchronization();
    if (!ui.song.paused) {
      startMetronomeScheduler();
    }
    updateMetronomeDisplay(ui.song.currentTime);
  });

  ui.playPauseButton.addEventListener("click", togglePlayback);
  ui.rewindButton.addEventListener("click", () => seekBy(-10));
  ui.forwardButton.addEventListener("click", () => seekBy(10));
  ui.filePicker.addEventListener("change", handleManualFile);

  ui.progressBar.addEventListener("pointerdown", beginProgressDrag);
  window.addEventListener("pointermove", continueProgressDrag);
  window.addEventListener("pointerup", endProgressDrag);
  ui.progressBar.addEventListener("keydown", handleProgressKeyboard);

  ui.audibleMetronome.addEventListener("change", async () => {
    if (ui.audibleMetronome.checked) {
      await ensureAudioContextRunning();
      resetMetronomeSynchronization();
      if (!ui.song.paused) {
        startMetronomeScheduler();
      }
    }
  });

  window.addEventListener("resize", () => {
    window.clearTimeout(state.resizeTimer);
    state.resizeTimer = window.setTimeout(renderAnalysisCanvas, 120);
  });
}

async function togglePlayback() {
  try {
    await ensureAudioContextRunning();
    if (ui.song.paused) {
      await ui.song.play();
    } else {
      ui.song.pause();
    }
  } catch (error) {
    console.error(error);
    setPlaybackStatus(`Playback failed: ${error.message}`, "error");
  }
}

function seekBy(seconds) {
  if (!Number.isFinite(ui.song.duration)) {
    return;
  }
  ui.song.currentTime = clamp(ui.song.currentTime + seconds, 0, ui.song.duration);
}

function beginProgressDrag(event) {
  if (!Number.isFinite(ui.song.duration)) {
    return;
  }
  event.preventDefault();
  state.isDraggingProgress = true;
  ui.progressBar.setPointerCapture?.(event.pointerId);
  seekFromPointer(event);
}

function continueProgressDrag(event) {
  if (!state.isDraggingProgress) {
    return;
  }
  event.preventDefault();
  seekFromPointer(event);
}

function endProgressDrag(event) {
  if (!state.isDraggingProgress) {
    return;
  }
  state.isDraggingProgress = false;
  ui.progressBar.releasePointerCapture?.(event.pointerId);
  resetMetronomeSynchronization();
}

function seekFromPointer(event) {
  const rectangle = ui.progressBar.getBoundingClientRect();
  const ratio = clamp((event.clientX - rectangle.left) / rectangle.width, 0, 1);
  ui.song.currentTime = ratio * ui.song.duration;
  updateTransport();
}

function handleProgressKeyboard(event) {
  const keySteps = {
    ArrowLeft: -5,
    ArrowRight: 5,
    PageDown: -30,
    PageUp: 30,
    Home: -Infinity,
    End: Infinity
  };

  if (!(event.key in keySteps) || !Number.isFinite(ui.song.duration)) {
    return;
  }

  event.preventDefault();
  const step = keySteps[event.key];
  if (step === -Infinity) {
    ui.song.currentTime = 0;
  } else if (step === Infinity) {
    ui.song.currentTime = ui.song.duration;
  } else {
    seekBy(step);
  }
}

async function handleManualFile(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  if (state.activeObjectUrl) {
    URL.revokeObjectURL(state.activeObjectUrl);
  }

  state.activeObjectUrl = URL.createObjectURL(file);
  state.analysisSourceName = file.name;
  ui.trackTitle.textContent = file.name;
  ui.song.src = state.activeObjectUrl;
  ui.song.load();

  resetAnalysisUi();
  try {
    await analyzeArrayBuffer(await file.arrayBuffer(), file.name);
  } catch (error) {
    console.error(error);
    setAnalysisStatus(`Analysis failed: ${error.message}`, "error");
  }
}

async function analyzeTrackFromUrl(url) {
  if (state.analysisStarted) {
    return;
  }
  state.analysisStarted = true;
  state.analysisSourceName = url;
  setAnalysisStatus("Loading MP3 for analysis…");
  setAnalysisProgress(0.03);

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    state.analysisStarted = false;
    throw new Error(
      "The browser blocked local file analysis. Open this folder through a local HTTP server or use the file picker."
    );
  }

  if (!response.ok) {
    state.analysisStarted = false;
    throw new Error(`The MP3 request returned HTTP ${response.status}.`);
  }

  await analyzeArrayBuffer(await response.arrayBuffer(), url);
}

async function analyzeArrayBuffer(arrayBuffer, sourceName) {
  state.analysisStarted = true;
  state.analysis = null;
  resetMetronomeSynchronization();
  setAnalysisStatus("Decoding MP3…");
  setAnalysisProgress(0.08);

  const context = getAudioContext();
  const decodedBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
  state.decodedBuffer = decodedBuffer;

  setAnalysisStatus("Creating mono analysis signal…");
  const analysisSignal = await downmixAndResample(decodedBuffer, TARGET_ANALYSIS_RATE, (ratio) => {
    setAnalysisProgress(0.08 + ratio * 0.2);
  });

  setAnalysisStatus("Finding musical transients and onsets…");
  const onsetData = await buildOnsetEnvelope(
    analysisSignal.samples,
    analysisSignal.sampleRate,
    (ratio) => setAnalysisProgress(0.28 + ratio * 0.25)
  );

  setAnalysisStatus("Estimating local BPM and meter…");
  const tempoMap = await buildTempoMap(
    onsetData.envelope,
    onsetData.frameRate,
    decodedBuffer.duration,
    (ratio) => setAnalysisProgress(0.53 + ratio * 0.37)
  );

  if (tempoMap.regions.length === 0) {
    throw new Error("Not enough rhythmic activity was found to construct a tempo map.");
  }

  const summary = summarizeAnalysis(tempoMap.regions);
  const changes = buildChangeLog(tempoMap.regions);

  state.analysis = {
    sourceName,
    duration: decodedBuffer.duration,
    sampleRate: decodedBuffer.sampleRate,
    onsetEnvelope: onsetData.envelope,
    onsetFrameRate: onsetData.frameRate,
    peakTimes: onsetData.peakTimes,
    regions: tempoMap.regions,
    summary,
    changes
  };

  setAnalysisProgress(1);
  setAnalysisStatus(
    `Complete: ${tempoMap.regions.length} rhythmic region${tempoMap.regions.length === 1 ? "" : "s"} mapped.`,
    "success"
  );
  renderAnalysisResults();
  resetMetronomeSynchronization();
  updateMetronomeDisplay(ui.song.currentTime || 0);
}

async function downmixAndResample(audioBuffer, targetRate, progressCallback) {
  const sourceRate = audioBuffer.sampleRate;
  const channelData = [];
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    channelData.push(audioBuffer.getChannelData(channel));
  }

  const outputLength = Math.max(1, Math.floor(audioBuffer.duration * targetRate));
  const output = new Float32Array(outputLength);
  const sourcePerOutput = sourceRate / targetRate;
  const chunkSize = 120000;

  for (let start = 0; start < outputLength; start += chunkSize) {
    const end = Math.min(outputLength, start + chunkSize);
    for (let outputIndex = start; outputIndex < end; outputIndex += 1) {
      const sourcePosition = outputIndex * sourcePerOutput;
      const indexA = Math.floor(sourcePosition);
      const indexB = Math.min(indexA + 1, audioBuffer.length - 1);
      const fraction = sourcePosition - indexA;
      let mixedSample = 0;

      for (const channel of channelData) {
        mixedSample += channel[indexA] + (channel[indexB] - channel[indexA]) * fraction;
      }
      output[outputIndex] = mixedSample / channelData.length;
    }

    progressCallback?.(end / outputLength);
    await yieldToBrowser();
  }

  return { samples: output, sampleRate: targetRate };
}

async function buildOnsetEnvelope(samples, sampleRate, progressCallback) {
  const frameSize = 512;
  const hopSize = 128;
  const frameCount = Math.max(1, Math.floor((samples.length - frameSize) / hopSize));
  const descriptor = new Float32Array(frameCount);
  const flux = new Float32Array(frameCount);
  const envelope = new Float32Array(frameCount);
  let previousDescriptor = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * hopSize;
    let energy = 0;
    let differenceEnergy = 0;
    let previousSample = samples[offset];

    for (let index = 0; index < frameSize; index += 1) {
      const sample = samples[offset + index];
      const difference = sample - previousSample;
      energy += sample * sample;
      differenceEnergy += difference * difference;
      previousSample = sample;
    }

    const rms = Math.sqrt(energy / frameSize);
    const differenceRms = Math.sqrt(differenceEnergy / frameSize);
    const currentDescriptor = 0.62 * Math.log1p(rms * 1000) + 0.38 * Math.log1p(differenceRms * 1000);
    descriptor[frame] = currentDescriptor;
    flux[frame] = Math.max(0, currentDescriptor - previousDescriptor);
    previousDescriptor = currentDescriptor;

    if (frame % 3000 === 0) {
      progressCallback?.(0.48 * (frame / frameCount));
      await yieldToBrowser();
    }
  }

  const frameRate = sampleRate / hopSize;
  const thresholdRadius = Math.max(4, Math.round(frameRate * 0.42));
  const prefix = new Float64Array(frameCount + 1);
  for (let index = 0; index < frameCount; index += 1) {
    prefix[index + 1] = prefix[index] + flux[index];
  }

  let maximum = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const left = Math.max(0, index - thresholdRadius);
    const right = Math.min(frameCount, index + thresholdRadius + 1);
    const localMean = (prefix[right] - prefix[left]) / (right - left);
    const positiveFlux = Math.max(0, flux[index] - localMean * 1.1);
    envelope[index] = positiveFlux;
    maximum = Math.max(maximum, positiveFlux);

    if (index % 5000 === 0) {
      progressCallback?.(0.48 + 0.38 * (index / frameCount));
      await yieldToBrowser();
    }
  }

  if (maximum > 0) {
    for (let index = 0; index < envelope.length; index += 1) {
      envelope[index] /= maximum;
    }
  }

  // Light smoothing makes autocorrelation more stable without erasing attacks.
  const smoothed = new Float32Array(frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    smoothed[index] =
      (envelope[index - 1] || 0) * 0.2 +
      envelope[index] * 0.6 +
      (envelope[index + 1] || 0) * 0.2;
  }

  const peakTimes = [];
  const minimumPeakDistance = Math.max(1, Math.round(frameRate * 0.075));
  let lastPeak = -minimumPeakDistance;
  for (let index = 2; index < smoothed.length - 2; index += 1) {
    const value = smoothed[index];
    if (
      value > 0.08 &&
      value >= smoothed[index - 1] &&
      value > smoothed[index + 1] &&
      index - lastPeak >= minimumPeakDistance
    ) {
      peakTimes.push(index / frameRate);
      lastPeak = index;
    }
  }

  progressCallback?.(1);
  return { envelope: smoothed, frameRate, peakTimes };
}

async function buildTempoMap(envelope, frameRate, duration, progressCallback) {
  const windowSeconds = Math.min(TEMPO_WINDOW_SECONDS, Math.max(10, duration));
  const hopSeconds = duration <= windowSeconds ? windowSeconds : TEMPO_HOP_SECONDS;
  const rawSegments = [];

  const starts = [];
  if (duration <= windowSeconds) {
    starts.push(0);
  } else {
    for (let start = 0; start < duration; start += hopSeconds) {
      const clampedStart = Math.min(start, Math.max(0, duration - windowSeconds));
      if (starts.length === 0 || Math.abs(clampedStart - starts[starts.length - 1]) > 0.5) {
        starts.push(clampedStart);
      }
      if (clampedStart >= duration - windowSeconds) {
        break;
      }
    }
  }

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = Math.min(duration, start + windowSeconds);
    const estimate = estimateRhythmWindow(envelope, frameRate, start, end);
    if (estimate) {
      rawSegments.push({
        ...estimate,
        analysisStart: start,
        analysisEnd: end,
        center: (start + end) / 2
      });
    }

    progressCallback?.((index + 1) / Math.max(1, starts.length) * 0.72);
    await yieldToBrowser();
  }

  if (rawSegments.length === 0) {
    return { regions: [] };
  }

  smoothRawSegments(rawSegments);
  let regions = convertSegmentsToRegions(rawSegments, duration);
  regions = mergeSimilarRegions(regions);
  regions = removeVeryShortRegions(regions);

  for (let index = 0; index < regions.length; index += 1) {
    refineRegionGrid(regions[index], envelope, frameRate);
    progressCallback?.(0.72 + 0.28 * ((index + 1) / regions.length));
    await yieldToBrowser();
  }

  return { regions };
}

function estimateRhythmWindow(envelope, frameRate, startTime, endTime) {
  const startIndex = Math.max(0, Math.floor(startTime * frameRate));
  const endIndex = Math.min(envelope.length, Math.ceil(endTime * frameRate));
  const length = endIndex - startIndex;
  if (length < frameRate * 4) {
    return null;
  }

  let totalEnergy = 0;
  for (let index = startIndex; index < endIndex; index += 1) {
    totalEnergy += envelope[index] * envelope[index];
  }
  if (totalEnergy < 0.01) {
    return null;
  }

  const minimumLag = Math.max(2, Math.floor(frameRate * 60 / MAX_BPM));
  const maximumLag = Math.min(length - 2, Math.ceil(frameRate * 60 / MIN_BPM));
  const autocorrelation = new Float64Array(maximumLag + 1);
  const scores = [];

  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let numerator = 0;
    let energyA = 0;
    let energyB = 0;

    for (let localIndex = lag; localIndex < length; localIndex += 1) {
      const valueA = envelope[startIndex + localIndex];
      const valueB = envelope[startIndex + localIndex - lag];
      numerator += valueA * valueB;
      energyA += valueA * valueA;
      energyB += valueB * valueB;
    }

    autocorrelation[lag] = numerator / Math.sqrt(energyA * energyB + 1e-12);
  }

  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    const bpm = frameRate * 60 / lag;
    let score = autocorrelation[lag];
    if (lag * 2 <= maximumLag) {
      score += autocorrelation[lag * 2] * 0.48;
    }
    if (lag * 3 <= maximumLag) {
      score += autocorrelation[lag * 3] * 0.18;
    }

    // A weak prior reduces extreme half-time/double-time choices while still
    // allowing the evidence to win.
    const centerPrior = Math.exp(-Math.pow((bpm - 118) / 80, 2));
    score *= 0.93 + 0.07 * centerPrior;
    scores.push({ lag, bpm, score });
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (!best || !Number.isFinite(best.score)) {
    return null;
  }

  const refinedLag = refineLagParabolically(best.lag, autocorrelation, minimumLag, maximumLag);
  const bpm = frameRate * 60 / refinedLag;
  const scoreMedian = median(scores.slice(0, Math.min(scores.length, 50)).map((item) => item.score));
  const confidence = clamp((best.score - scoreMedian) / Math.max(0.08, Math.abs(best.score)), 0, 1);

  const phase = findBeatPhase(envelope, frameRate, startTime, endTime, bpm);
  const beatStrengths = collectBeatStrengths(
    envelope,
    frameRate,
    phase.firstBeatTime,
    bpm,
    startTime,
    endTime
  );
  const meterEstimate = estimateMeter(beatStrengths);

  return {
    bpm,
    tempoConfidence: confidence,
    firstBeatTime: phase.firstBeatTime,
    phaseScore: phase.score,
    meter: meterEstimate.label,
    beatsPerBar: meterEstimate.beatsPerBar,
    downbeatClass: meterEstimate.downbeatClass,
    meterConfidence: meterEstimate.confidence
  };
}

function refineLagParabolically(lag, values, minimumLag, maximumLag) {
  if (lag <= minimumLag || lag >= maximumLag) {
    return lag;
  }
  const left = values[lag - 1];
  const center = values[lag];
  const right = values[lag + 1];
  const denominator = left - 2 * center + right;
  if (Math.abs(denominator) < 1e-9) {
    return lag;
  }
  const offset = clamp(0.5 * (left - right) / denominator, -0.5, 0.5);
  return lag + offset;
}

function findBeatPhase(envelope, frameRate, startTime, endTime, bpm) {
  const intervalFrames = frameRate * 60 / bpm;
  const phaseCount = Math.max(1, Math.round(intervalFrames));
  const startIndex = Math.floor(startTime * frameRate);
  const endIndex = Math.min(envelope.length, Math.ceil(endTime * frameRate));
  let bestPhase = 0;
  let bestScore = -Infinity;

  for (let phase = 0; phase < phaseCount; phase += 1) {
    let score = 0;
    let count = 0;
    for (
      let position = startIndex + phase;
      position < endIndex;
      position += intervalFrames
    ) {
      score += sampleEnvelopeAround(envelope, position, 2);
      count += 1;
    }
    score /= Math.max(1, count);
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  return {
    firstBeatTime: (startIndex + bestPhase) / frameRate,
    score: Math.max(0, bestScore)
  };
}

function collectBeatStrengths(envelope, frameRate, firstBeatTime, bpm, startTime, endTime) {
  const interval = 60 / bpm;
  const strengths = [];
  let beatTime = firstBeatTime;

  while (beatTime - interval >= startTime) {
    beatTime -= interval;
  }
  while (beatTime < startTime) {
    beatTime += interval;
  }

  for (; beatTime < endTime; beatTime += interval) {
    strengths.push(sampleEnvelopeAround(envelope, beatTime * frameRate, 2));
  }
  return strengths;
}

function estimateMeter(beatStrengths) {
  const candidates = [
    { beatsPerBar: 3, label: "3/4", prior: 0.98 },
    { beatsPerBar: 4, label: "4/4", prior: 1.08 },
    { beatsPerBar: 5, label: "5/4", prior: 0.9 },
    { beatsPerBar: 6, label: "6/8", prior: 0.96 },
    { beatsPerBar: 7, label: "7/8", prior: 0.86 }
  ];

  if (beatStrengths.length < 8) {
    return { label: "4/4", beatsPerBar: 4, downbeatClass: 0, confidence: 0.12 };
  }

  const overallMean = mean(beatStrengths);
  const overallDeviation = standardDeviation(beatStrengths, overallMean) + 1e-6;
  const results = [];

  for (const candidate of candidates) {
    const classValues = Array.from({ length: candidate.beatsPerBar }, () => []);
    for (let index = 0; index < beatStrengths.length; index += 1) {
      classValues[index % candidate.beatsPerBar].push(beatStrengths[index]);
    }

    const classMeans = classValues.map((values) => mean(values));
    const strongest = indexOfMaximum(classMeans);
    const otherMeans = classMeans.filter((_, index) => index !== strongest);
    const accentContrast = (classMeans[strongest] - mean(otherMeans)) / overallDeviation;

    let periodicityNumerator = 0;
    let periodicityA = 0;
    let periodicityB = 0;
    for (let index = candidate.beatsPerBar; index < beatStrengths.length; index += 1) {
      const a = beatStrengths[index] - overallMean;
      const b = beatStrengths[index - candidate.beatsPerBar] - overallMean;
      periodicityNumerator += a * b;
      periodicityA += a * a;
      periodicityB += b * b;
    }
    const periodicity = periodicityNumerator / Math.sqrt(periodicityA * periodicityB + 1e-12);

    let withinClassVariance = 0;
    for (let classIndex = 0; classIndex < classValues.length; classIndex += 1) {
      for (const value of classValues[classIndex]) {
        withinClassVariance += Math.pow(value - classMeans[classIndex], 2);
      }
    }
    withinClassVariance /= beatStrengths.length;
    const consistency = 1 / (1 + withinClassVariance * 18);

    const score =
      candidate.prior *
      (0.5 * Math.max(-0.25, periodicity) +
        0.35 * Math.max(0, accentContrast) +
        0.15 * consistency);

    results.push({ ...candidate, downbeatClass: strongest, score });
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  const second = results[1];
  const confidence = clamp((best.score - second.score + 0.08) / (Math.abs(best.score) + 0.18), 0.05, 0.92);

  return {
    label: best.label,
    beatsPerBar: best.beatsPerBar,
    downbeatClass: best.downbeatClass,
    confidence
  };
}

function smoothRawSegments(segments) {
  if (segments.length < 2) {
    return;
  }

  const originalBpms = segments.map((segment) => segment.bpm);
  for (let index = 0; index < segments.length; index += 1) {
    const neighborhood = originalBpms.slice(Math.max(0, index - 1), Math.min(segments.length, index + 2));
    segments[index].bpm = median(neighborhood);
  }

  const originalMeters = segments.map((segment) => segment.meter);
  for (let index = 1; index < segments.length - 1; index += 1) {
    if (originalMeters[index - 1] === originalMeters[index + 1] && originalMeters[index] !== originalMeters[index - 1]) {
      const neighbor = segments[index - 1];
      segments[index].meter = neighbor.meter;
      segments[index].beatsPerBar = neighbor.beatsPerBar;
      segments[index].downbeatClass = neighbor.downbeatClass;
      segments[index].meterConfidence *= 0.8;
    }
  }
}

function convertSegmentsToRegions(segments, duration) {
  return segments.map((segment, index) => {
    const start = index === 0 ? 0 : (segments[index - 1].center + segment.center) / 2;
    const end = index === segments.length - 1 ? duration : (segment.center + segments[index + 1].center) / 2;
    return {
      start,
      end,
      bpm: segment.bpm,
      meter: segment.meter,
      beatsPerBar: segment.beatsPerBar,
      downbeatClass: segment.downbeatClass,
      tempoConfidence: segment.tempoConfidence,
      meterConfidence: segment.meterConfidence,
      firstBeatTime: segment.firstBeatTime,
      downbeatTime: segment.firstBeatTime
    };
  });
}

function mergeSimilarRegions(regions) {
  if (regions.length <= 1) {
    return regions;
  }

  const merged = [{ ...regions[0] }];
  for (let index = 1; index < regions.length; index += 1) {
    const current = regions[index];
    const previous = merged[merged.length - 1];
    const relativeDifference = Math.abs(current.bpm - previous.bpm) / Math.max(1, previous.bpm);

    if (current.meter === previous.meter && relativeDifference < 0.045) {
      const previousDuration = previous.end - previous.start;
      const currentDuration = current.end - current.start;
      const totalDuration = previousDuration + currentDuration;
      previous.bpm =
        (previous.bpm * previousDuration + current.bpm * currentDuration) / totalDuration;
      previous.tempoConfidence =
        (previous.tempoConfidence * previousDuration + current.tempoConfidence * currentDuration) / totalDuration;
      previous.meterConfidence =
        (previous.meterConfidence * previousDuration + current.meterConfidence * currentDuration) / totalDuration;
      previous.end = current.end;
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

function removeVeryShortRegions(regions) {
  if (regions.length <= 1) {
    return regions;
  }

  const output = regions.map((region) => ({ ...region }));
  let changed = true;
  while (changed && output.length > 1) {
    changed = false;
    for (let index = 0; index < output.length; index += 1) {
      const region = output[index];
      if (region.end - region.start >= 7) {
        continue;
      }

      const previous = output[index - 1];
      const next = output[index + 1];
      let mergeTargetIndex;
      if (!previous) {
        mergeTargetIndex = index + 1;
      } else if (!next) {
        mergeTargetIndex = index - 1;
      } else {
        const previousCost = rhythmicDistance(region, previous);
        const nextCost = rhythmicDistance(region, next);
        mergeTargetIndex = previousCost <= nextCost ? index - 1 : index + 1;
      }

      if (mergeTargetIndex < index) {
        output[mergeTargetIndex].end = region.end;
      } else {
        output[mergeTargetIndex].start = region.start;
      }
      output.splice(index, 1);
      changed = true;
      break;
    }
  }

  return mergeSimilarRegions(output);
}

function rhythmicDistance(a, b) {
  const tempoDistance = Math.abs(a.bpm - b.bpm) / Math.max(1, b.bpm);
  const meterPenalty = a.meter === b.meter ? 0 : 0.35;
  return tempoDistance + meterPenalty;
}

function refineRegionGrid(region, envelope, frameRate) {
  const phase = findBeatPhase(envelope, frameRate, region.start, region.end, region.bpm);
  region.firstBeatTime = phase.firstBeatTime;

  const strengths = collectBeatStrengths(
    envelope,
    frameRate,
    region.firstBeatTime,
    region.bpm,
    region.start,
    region.end
  );
  const meter = estimateMeter(strengths);

  // Keep a meter supported by the local region; this can differ from the
  // smoothed window result and is recorded as a genuine local change.
  region.meter = meter.label;
  region.beatsPerBar = meter.beatsPerBar;
  region.downbeatClass = meter.downbeatClass;
  region.meterConfidence = (region.meterConfidence + meter.confidence) / 2;

  const interval = 60 / region.bpm;
  let downbeatTime = region.firstBeatTime + region.downbeatClass * interval;
  const barDuration = interval * region.beatsPerBar;

  while (downbeatTime > region.start) {
    downbeatTime -= barDuration;
  }
  while (downbeatTime + barDuration <= region.start) {
    downbeatTime += barDuration;
  }
  region.downbeatTime = downbeatTime;
}

function summarizeAnalysis(regions) {
  const weightedBpms = [];
  const meterDurations = new Map();
  let tempoConfidenceNumerator = 0;
  let meterConfidenceNumerator = 0;
  let durationTotal = 0;

  for (const region of regions) {
    const duration = Math.max(0.001, region.end - region.start);
    weightedBpms.push({ value: region.bpm, weight: duration });
    meterDurations.set(region.meter, (meterDurations.get(region.meter) || 0) + duration);
    tempoConfidenceNumerator += region.tempoConfidence * duration;
    meterConfidenceNumerator += region.meterConfidence * duration;
    durationTotal += duration;
  }

  const overallMeter = [...meterDurations.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
  return {
    bpm: weightedMedian(weightedBpms),
    meter: overallMeter,
    tempoConfidence: tempoConfidenceNumerator / durationTotal,
    meterConfidence: meterConfidenceNumerator / durationTotal
  };
}

function buildChangeLog(regions) {
  const changes = [];
  for (let index = 1; index < regions.length; index += 1) {
    const previous = regions[index - 1];
    const current = regions[index];
    const descriptions = [];

    if (Math.abs(current.bpm - previous.bpm) / previous.bpm >= 0.03) {
      descriptions.push(`Tempo ${previous.bpm.toFixed(1)} → ${current.bpm.toFixed(1)} BPM`);
    }
    if (current.meter !== previous.meter) {
      descriptions.push(`Meter ${previous.meter} → ${current.meter}`);
    }

    if (descriptions.length > 0) {
      changes.push({
        time: current.start,
        description: descriptions.join("; "),
        action: "Start a new beat grid and recalculate downbeat/bar phase from this boundary."
      });
    }
  }
  return changes;
}

function renderAnalysisResults() {
  if (!state.analysis) {
    return;
  }

  const { summary, regions, changes } = state.analysis;
  ui.overallBpm.textContent = summary.bpm.toFixed(1);
  ui.overallBpmConfidence.textContent = `${confidenceLabel(summary.tempoConfidence)} confidence (${formatPercent(summary.tempoConfidence)})`;
  ui.overallMeter.textContent = summary.meter;
  ui.overallMeterConfidence.textContent = `${confidenceLabel(summary.meterConfidence)} confidence (${formatPercent(summary.meterConfidence)})`;

  ui.regionTableBody.innerHTML = regions
    .map(
      (region, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${formatTime(region.start, 3)}</td>
          <td>${formatTime(region.end, 3)}</td>
          <td>${region.bpm.toFixed(1)}</td>
          <td>${escapeHtml(region.meter)}</td>
          <td>${formatPercent(region.tempoConfidence)}</td>
          <td>${formatPercent(region.meterConfidence)}</td>
        </tr>`
    )
    .join("");

  if (changes.length === 0) {
    ui.changeTableBody.innerHTML = `
      <tr class="empty-row">
        <td>—</td>
        <td>No stable tempo or meter changes were detected.</td>
        <td>Use one continuous internal beat grid.</td>
      </tr>`;
  } else {
    ui.changeTableBody.innerHTML = changes
      .map(
        (change) => `
          <tr>
            <td>${formatTime(change.time, 3)}</td>
            <td>${escapeHtml(change.description)}</td>
            <td>${escapeHtml(change.action)}</td>
          </tr>`
      )
      .join("");
  }

  renderProgressMarkers();
  renderAnalysisCanvas();
}

function renderProgressMarkers() {
  ui.progressMarkers.replaceChildren();
  if (!state.analysis || !Number.isFinite(state.analysis.duration)) {
    return;
  }

  for (let index = 1; index < state.analysis.regions.length; index += 1) {
    const marker = document.createElement("span");
    marker.className = "progress-marker";
    marker.style.left = `${(state.analysis.regions[index].start / state.analysis.duration) * 100}%`;
    marker.title = `Rhythmic region change at ${formatTime(state.analysis.regions[index].start, 3)}`;
    ui.progressMarkers.appendChild(marker);
  }
}

function renderAnalysisCanvas() {
  const canvas = ui.analysisCanvas;
  const container = ui.analysisTimeline;
  const rectangle = container.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rectangle.width * pixelRatio));
  const height = Math.max(1, Math.round(rectangle.height * pixelRatio));

  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);

  context.fillStyle = "#101010";
  context.fillRect(0, 0, width, height);

  if (!state.analysis) {
    context.fillStyle = "#8f8f8f";
    context.font = `${14 * pixelRatio}px Courier New`;
    context.fillText("Analysis waveform will appear here.", 16 * pixelRatio, 28 * pixelRatio);
    return;
  }

  const envelope = state.analysis.onsetEnvelope;
  const duration = state.analysis.duration;
  const frameRate = state.analysis.onsetFrameRate;
  const pointsPerPixel = envelope.length / width;

  context.strokeStyle = "#8f8f8f";
  context.lineWidth = Math.max(1, pixelRatio);
  context.beginPath();
  for (let x = 0; x < width; x += 1) {
    const start = Math.floor(x * pointsPerPixel);
    const end = Math.min(envelope.length, Math.ceil((x + 1) * pointsPerPixel));
    let maximum = 0;
    for (let index = start; index < end; index += 1) {
      maximum = Math.max(maximum, envelope[index]);
    }
    const y = height - maximum * (height * 0.88) - height * 0.06;
    if (x === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();

  context.strokeStyle = "#f0c36a";
  context.lineWidth = Math.max(1, pixelRatio * 1.4);
  for (let index = 1; index < state.analysis.regions.length; index += 1) {
    const x = state.analysis.regions[index].start / duration * width;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }

  context.fillStyle = "#b8b8b8";
  context.font = `${11 * pixelRatio}px Courier New`;
  context.fillText(`Onset frames: ${envelope.length.toLocaleString()} at ${frameRate.toFixed(2)} Hz`, 10 * pixelRatio, 17 * pixelRatio);
}

function startAnimationLoop() {
  const animate = () => {
    updateTransport();
    updateMetronomeDisplay(ui.song.currentTime || 0);
    state.animationFrameId = window.requestAnimationFrame(animate);
  };
  state.animationFrameId = window.requestAnimationFrame(animate);
}

function updateTransport() {
  const duration = Number.isFinite(ui.song.duration) ? ui.song.duration : 0;
  const currentTime = Number.isFinite(ui.song.currentTime) ? ui.song.currentTime : 0;
  const ratio = duration > 0 ? clamp(currentTime / duration, 0, 1) : 0;

  ui.progressFill.style.width = `${ratio * 100}%`;
  ui.analysisPlayhead.style.left = `${ratio * 100}%`;
  ui.progressBar.setAttribute("aria-valuenow", (ratio * 100).toFixed(2));
  ui.timeDisplay.textContent = `${formatTime(currentTime, 3)} / ${formatTime(duration, 3)}`;
}

function updatePlaybackUi() {
  const ready = ui.song.readyState >= HTMLMediaElement.HAVE_METADATA;
  ui.playPauseButton.disabled = !ready;
  ui.rewindButton.disabled = !ready;
  ui.forwardButton.disabled = !ready;
}

function updateMetronomeDisplay(time) {
  const position = getBeatPosition(time);
  if (!position) {
    ui.currentBpm.textContent = "—";
    ui.currentMeter.textContent = "—";
    ui.currentRegion.textContent = "No active tempo region";
    ui.currentMeterConfidence.textContent = "No active meter region";
    ui.beatNumber.textContent = "—";
    ui.barNumber.textContent = "—";
    ui.beatTime.textContent = "—";
    ui.nextBeatTime.textContent = "—";
    ui.beatPhaseFill.style.width = "0%";
    ui.syncMessage.textContent = state.analysis
      ? "Playback is outside the analyzed map."
      : "Metronome is waiting for analysis.";
    return;
  }

  const { region, regionIndex, beatIndex, beatInBar, barNumber, beatTime, nextBeatTime, phase } = position;
  ui.currentBpm.textContent = region.bpm.toFixed(1);
  ui.currentMeter.textContent = region.meter;
  ui.currentRegion.textContent = `Region ${regionIndex + 1}: ${formatTime(region.start, 2)}–${formatTime(region.end, 2)}`;
  ui.currentMeterConfidence.textContent = `${confidenceLabel(region.meterConfidence)} confidence (${formatPercent(region.meterConfidence)})`;
  ui.beatNumber.textContent = String(beatInBar);
  ui.barNumber.textContent = String(barNumber);
  ui.beatTime.textContent = formatTime(beatTime, 3);
  ui.nextBeatTime.textContent = formatTime(nextBeatTime, 3);
  ui.beatPhaseFill.style.width = `${phase * 100}%`;
  ui.syncMessage.textContent = ui.song.paused
    ? "Paused; beat position remains derived from the current song time."
    : "Locked to song time; seeks and transport changes trigger recalculation.";

  const beatKey = `${regionIndex}:${beatIndex}`;
  if (!ui.song.paused && beatKey !== state.lastVisualBeatKey) {
    pulseMetronome(beatInBar === 1);
    state.lastVisualBeatKey = beatKey;
  }
}

function pulseMetronome(isDownbeat) {
  ui.metronomeOrb.classList.remove("pulse", "downbeat");
  // Force the browser to notice repeated pulses on adjacent beats.
  void ui.metronomeOrb.offsetWidth;
  ui.metronomeOrb.classList.add("pulse");
  if (isDownbeat) {
    ui.metronomeOrb.classList.add("downbeat");
  }

  window.setTimeout(() => {
    ui.metronomeOrb.classList.remove("pulse", "downbeat");
  }, 95);
}

function getBeatPosition(time) {
  if (!state.analysis || state.analysis.regions.length === 0) {
    return null;
  }

  const regionIndex = findRegionIndex(time);
  if (regionIndex < 0) {
    return null;
  }

  const region = state.analysis.regions[regionIndex];
  const interval = 60 / region.bpm;
  const relative = (time - region.downbeatTime) / interval;
  const beatIndex = Math.floor(relative + 1e-8);
  const beatTime = region.downbeatTime + beatIndex * interval;
  const nextBeatTime = beatTime + interval;
  const beatInBar = positiveModulo(beatIndex, region.beatsPerBar) + 1;
  const barNumber = Math.floor(beatIndex / region.beatsPerBar) + 1;
  const phase = clamp((time - beatTime) / interval, 0, 1);

  return {
    region,
    regionIndex,
    interval,
    beatIndex,
    beatTime,
    nextBeatTime,
    beatInBar,
    barNumber,
    phase
  };
}

function findRegionIndex(time) {
  const regions = state.analysis?.regions || [];
  if (regions.length === 0) {
    return -1;
  }

  let low = 0;
  let high = regions.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const region = regions[middle];
    const isLast = middle === regions.length - 1;
    if (time < region.start) {
      high = middle - 1;
    } else if (time >= region.end && !isLast) {
      low = middle + 1;
    } else if (time <= region.end || isLast) {
      return middle;
    }
  }
  return -1;
}

function startMetronomeScheduler() {
  stopMetronomeScheduler();
  state.schedulerId = window.setInterval(scheduleUpcomingClicks, SCHEDULER_INTERVAL_MS);
  scheduleUpcomingClicks();
}

function stopMetronomeScheduler() {
  if (state.schedulerId !== null) {
    window.clearInterval(state.schedulerId);
    state.schedulerId = null;
  }
}

function resetMetronomeSynchronization() {
  state.lastVisualBeatKey = null;
  state.scheduledBeatKeys.clear();
}

function scheduleUpcomingClicks() {
  if (
    ui.song.paused ||
    !ui.audibleMetronome.checked ||
    !state.analysis ||
    !state.audioContext ||
    state.audioContext.state !== "running"
  ) {
    return;
  }

  const songNow = ui.song.currentTime;
  const horizon = songNow + SCHEDULER_LOOKAHEAD_SECONDS;
  let cursor = songNow - 0.002;
  let safety = 0;

  while (cursor <= horizon && safety < 16) {
    const next = getNextBeatAtOrAfter(cursor);
    if (!next || next.time > horizon) {
      break;
    }

    const key = `${next.regionIndex}:${next.beatIndex}`;
    if (!state.scheduledBeatKeys.has(key)) {
      const delay = Math.max(0, next.time - ui.song.currentTime);
      scheduleClick(state.audioContext.currentTime + delay, next.isDownbeat);
      state.scheduledBeatKeys.add(key);
    }

    cursor = next.time + 0.001;
    safety += 1;
  }

  // Keep this collection small during long playback.
  if (state.scheduledBeatKeys.size > 64) {
    state.scheduledBeatKeys = new Set([...state.scheduledBeatKeys].slice(-24));
  }
}

function getNextBeatAtOrAfter(time) {
  let regionIndex = findRegionIndex(time);
  if (regionIndex < 0) {
    return null;
  }

  const regions = state.analysis.regions;
  for (; regionIndex < regions.length; regionIndex += 1) {
    const region = regions[regionIndex];
    const interval = 60 / region.bpm;
    const localTime = Math.max(time, region.start);
    let beatIndex = Math.ceil((localTime - region.downbeatTime) / interval - 1e-8);
    let beatTime = region.downbeatTime + beatIndex * interval;

    if (beatTime < region.start) {
      beatIndex += Math.ceil((region.start - beatTime) / interval);
      beatTime = region.downbeatTime + beatIndex * interval;
    }

    if (beatTime < region.end || regionIndex === regions.length - 1) {
      return {
        time: beatTime,
        regionIndex,
        beatIndex,
        isDownbeat: positiveModulo(beatIndex, region.beatsPerBar) === 0
      };
    }
  }
  return null;
}

function scheduleClick(contextTime, isDownbeat) {
  const context = state.audioContext;
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.frequency.setValueAtTime(isDownbeat ? 1320 : 930, contextTime);
  gain.gain.setValueAtTime(0.0001, contextTime);
  gain.gain.exponentialRampToValueAtTime(isDownbeat ? 0.18 : 0.11, contextTime + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, contextTime + 0.045);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(contextTime);
  oscillator.stop(contextTime + 0.05);
}

function getAudioContext() {
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("This browser does not support the Web Audio API.");
    }
    state.audioContext = new AudioContextClass();
  }
  return state.audioContext;
}

async function ensureAudioContextRunning() {
  const context = getAudioContext();
  if (context.state === "suspended") {
    await context.resume();
  }
  return context;
}

function resetAnalysisUi() {
  state.analysis = null;
  state.analysisStarted = true;
  setAnalysisProgress(0);
  setAnalysisStatus("Preparing selected MP3…");
  ui.overallBpm.textContent = "—";
  ui.overallMeter.textContent = "—";
  ui.regionTableBody.innerHTML = '<tr class="empty-row"><td colspan="7">Analysis is running…</td></tr>';
  ui.changeTableBody.innerHTML = '<tr class="empty-row"><td colspan="3">Analysis is running…</td></tr>';
  ui.progressMarkers.replaceChildren();
  renderAnalysisCanvas();
}

function setPlaybackStatus(message, type = "normal") {
  ui.playbackStatus.textContent = message;
  ui.playbackStatus.classList.toggle("status-error", type === "error");
  ui.playbackStatus.classList.toggle("status-success", type === "success");
}

function setAnalysisStatus(message, type = "normal") {
  ui.analysisStatus.textContent = message;
  ui.analysisStatus.classList.toggle("status-error", type === "error");
  ui.analysisStatus.classList.toggle("status-success", type === "success");
}

function setAnalysisProgress(ratio) {
  ui.analysisProgressFill.style.width = `${clamp(ratio, 0, 1) * 100}%`;
}

function sampleEnvelopeAround(envelope, position, radius) {
  const center = Math.round(position);
  let maximum = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const index = center + offset;
    if (index >= 0 && index < envelope.length) {
      maximum = Math.max(maximum, envelope[index]);
    }
  }
  return maximum;
}

function confidenceLabel(value) {
  if (value >= 0.7) return "High";
  if (value >= 0.42) return "Medium";
  return "Low";
}

function formatPercent(value) {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`;
}

function formatTime(seconds, decimals = 0) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remaining = safeSeconds - minutes * 60;
  const width = decimals > 0 ? 3 + decimals : 2;
  return `${minutes}:${remaining.toFixed(decimals).padStart(width, "0")}`;
}

function weightedMedian(items) {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= totalWeight / 2) {
      return item.value;
    }
  }
  return sorted.at(-1)?.value || 0;
}

function mean(values) {
  if (!values || values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function standardDeviation(values, average = mean(values)) {
  if (!values || values.length === 0) return 0;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function indexOfMaximum(values) {
  let index = 0;
  for (let current = 1; current < values.length; current += 1) {
    if (values[current] > values[index]) {
      index = current;
    }
  }
  return index;
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}


import * as config from './config';
import * as mediasoup from 'mediasoup-client';
import deepEqual from 'deep-equal';
import debugModule from 'debug';

const $ = document.querySelector.bind(document);
const $$ = document.querySelectorAll.bind(document);
const log = debugModule('demo-app');
const warn = debugModule('demo-app:WARN');
const err = debugModule('demo-app:ERROR');

// questions:
//
//   see notes in docs for consumer.on("layerschange") about
//   detecting deactivation due to bandwidth. haven't been able
//   to trigger this in testing
//
//   'silence' is not a documented event. submit a patch
//
//   a paused producer still seems to send a fair amount of
//   bytes. does pausing not stop all simulcast tracks? some evidence
//   for this in that setting producer send to the lowest simulcast
//   layer, then pausing, seems to send at much lower bandwidth than
//   pausing without limiting simulcast to lowest layer, first
//
//   firefox seems not to respect setMaxSpatialLayers
//
//   what's the best way to set maximum bitrate for screen shares
//   (chrome crashes if multiple encodings are provided for screen
//   share streams)
//
//   "no Producer for received SDES chunk" after calling producer.close()
//   on both server and client (both Chrome and Firefox)
//
//   "no Consumer found for received Receiver report" when consuming a
//   simulcast stream
//
//   "inital "no Producer" messages while hooking up stream
//
//   if we leave the room and then rejoin, creating a send transport
//   works, but creating a recv transport show similar behavior to
//   creating a second consumer without doing the pause/resume trick:
//   we get a track that hangs on play()
//
//   firefox video rotation issue?
//
//   use h264 when sending from mobile safari?

export const myPeerId = uuidv4();

export let device,
           joined,
           localCam,
           localScreen,
           recvTransport,
           sendTransport,
           camVideoProducer,
           camAudioProducer,
           screenVideoProducer,
           currentActiveSpeaker = {},
           lastPollSyncData = {},
           consumers = [],
           pollingInterval;

export async function main() {
  try {
    device = new mediasoup.Device();
  } catch (e) {
    if (e.name === 'UnsupportedError') {
      console.error('browser not supported for video calls');
      return;
    } else {
      console.error(e);
    }
  }

  // use sendBeacon to tell the server we're disconnecting when
  // the page unloads
  window.addEventListener('unload', () => sig('leave', {}, true));
}


export async function joinRoom() {
  if (joined) {
    return;
  }
  log('join room');
  $('#join-control').style.display = 'none';
  try {
    // signal that we're a new peer and initialize our
    // mediasoup-client device, if this is our first time connecting
    let { routerRtpCapabilities } = await sig('join-as-new-peer');
    if (!device.loaded) {
      await device.load({ routerRtpCapabilities });
    }
    joined = true;
    $('#leave-room').style.display = 'initial';
  } catch (e) {
    err(e);
  }

  // super-simple signaling: let's poll at 1-second intervals
  pollingInterval = setInterval(async () => {
    let { error } = await pollAndUpdate();
    if (error) {
      clearInterval(pollingInterval);
      err(error);
    }
  }, 1000);
}

export async function sendCameraStreams() {
  log('send camera streams');
  $('#send-camera').style.display = 'none';

  // make sure we've joined the room and started our camera. these
  // functions don't do anything if they've already been called this
  // session
  await joinRoom();
  await startCamera();

  // create a transport for outgoing media, if we don't already have one
  if (!sendTransport) {
    sendTransport = await createTransport('send');
  }

  // start sending video. the transport logic will initiate a
  // signaling conversation with the server to set up an outbound rtp
  // stream for the camera video track. our createTransport() function
  // includes logic to tell the server to start the stream in a paused
  // state, if the checkbox in our UI is unchecked, so as soon as we
  // have a client-side camVideoProducer object, we need to set it to
  // paused as appropriate, too.
  camVideoProducer = await sendTransport.produce({
    track: localCam.getVideoTracks()[0],
    encodings: camEncodings(),
    appData: { mediaTag: 'cam-video' }
  });
  if (getCamPausedState()) {
    camVideoProducer.pause();
  }

  // same thing for audio, but we can use our already-created
  camAudioProducer = await sendTransport.produce({
    track: localCam.getAudioTracks()[0],
    appData: { mediaTag: 'cam-audio' }
  });
  if (getMicPausedState()) {
    camAudioProducer.pause();
  }
  $('#stop-streams').style.display = 'initial';
  showCameraInfo();
}

export async function startScreenshare() {
  log('start screen share');
  $('#share-screen').style.display = 'none';

  // make sure we've joined the room and that we have a sending
  // transport
  await joinRoom();
  if (!sendTransport) {
    sendTransport = await createTransport('send');
  }

  // get a screen share track
  localScreen = await navigator.mediaDevices.getDisplayMedia();

  // create a producer
  screenVideoProducer = await sendTransport.produce({
    track: localScreen.getVideoTracks()[0],
    encodings: screenshareEncodings(),
    appData: { mediaTag: 'screen-video' }
  });

  // handler for screen share stopped event (triggered by the
  // browser's built-in screen sharing ui)
  screenVideoProducer.track.onended = async () => {
    log('screen share stopped');
    await screenVideoProducer.pause();
    let { error } = await sig('close-producer',
                              { producerId: screenVideoProducer.id });
    screenVideoProducer.close();
    screenVideoProducer = null;
    $('#local-screen-pause-ctrl').style.display = 'none';
    $('#share-screen').style.display = 'initial';
  }

  $('#local-screen-pause-ctrl').style.display = 'initial';
}

export async function startCamera() {
  if (localCam) {
    return;
  }
  log('start camera');
  try {
    localCam = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
  } catch (e) {
    console.error('start camera error', e);
  }
}

export async function cycleCamera() {
  if (!(camVideoProducer && camVideoProducer.track)) {
    warn("can't cycle camera - no current camera track");
    return;
  }

  // find "next" device in device list
  let deviceId = await getCurrentDeviceId(),
      allDevices = await navigator.mediaDevices.enumerateDevices(),
      vidDevices = allDevices.filter((d) => d.kind === 'videoinput');
  if (!vidDevices.length > 1) {
    warn("can't cycle camera - only one camera");
    return;
  }
  let idx = vidDevices.findIndex((d) => d.deviceId === deviceId);
  if (idx === (vidDevices.length-1)) {
    idx = 0;
  } else {
    idx += 1;
  }

  // get a new video stream
  log('getting a video stream from device', vidDevices[idx].label);
  localCam = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: vidDevices[idx].deviceId } },
    audio: true
  });

  // replace the track we are sending
  await camVideoProducer.replaceTrack({ track: localCam.getVideoTracks()[0] });
  await camAudioProducer.replaceTrack({ track: localCam.getAudioTracks()[0] });

  // update the user interface
  showCameraInfo();
}

export async function stopStreams() {
  if (!(localCam || localScreen)) {
    return;
  }
  if (!sendTransport) {
    return;
  }
  log('stop sending media streams');
  let { error } = await sig('close-transport',
                            { transportId: sendTransport.id });
  if (error) {
    err(error);
  }
  // closing the sendTransport closes all associated producers. when
  // the camVideoProducer and camAudioProducer are closed,
  // mediasoup-client stops the local cam tracks, so we don't need to
  // do anything except set all our local variables to null.
  sendTransport.close();
  sendTransport = null;
  camVideoProducer = null;
  camAudioProducer = null;
  screenVideoProducer = null;
  localCam = null;
  localScreen = null;
  // update ui elements for sending streams
  $('#stop-streams').style.display = 'none';
  $('#send-camera').style.display = 'initial';
  $('#share-screen').style.display = 'initial';
  $('#local-screen-pause-ctrl').style.display = 'none';
  showCameraInfo();
}

export async function leaveRoom() {
  if (!joined) {
    return;
  }
  log('leave room');
  $('#leave-room').style.display = 'none';
  clearInterval(pollingInterval);
  localCam = null;
  // closing the transports closes all producers and consumers. we
  // don't need to do anything beyond closing the transports, except
  // to set all our local variables to their initial states
  recvTransport && recvTransport.close();
  sendTransport && sendTransport.close();
  recvTransport = null;
  sendTransport = null;
  camVideoProducer = null;
  camAudioProducer = null;
  screenVideoProducer  = null;
  localCam = null;
  localScreen = null;
  lastPollSyncData = {};
  consumers = [];
  joined = false;
  await sig('leave');
  // hacktastically restore ui to initial state
  $('#join-control').style.display = 'initial';
  $('#send-camera').style.display = 'initial';
  $('#stop-streams').style.display = 'none';
  $('#remote-video').innerHTML = '';
  $('#share-screen').style.display = 'initial';
  $('#local-screen-pause-ctrl').style.display = 'none';
  showCameraInfo();
  updatePeersDisplay();
}

export async function subscribeToTrack(peerId, mediaTag) {
  // todo: why do we if the (!consumer) ... under what circumstance
  // would we not have a consumer when we subscribe to a track?
  log('subscribe to track', peerId, mediaTag);

  if (!recvTransport) {
    recvTransport = await createTransport('recv');
  }

  let consumer = findConsumerForTrack(peerId, mediaTag);
  if (consumer) {
    err('already have consumer for track', peerId, mediaTag)
    return;
  };

  let consumerParameters = await sig('recv-track', {
    mediaTag,
    mediaPeerId: peerId,
    rtpCapabilities: device.rtpCapabilities
  });
  log('consumer parameters', consumerParameters);
  consumer = await recvTransport.consume({
    ...consumerParameters,
    appData: { peerId, mediaTag }
  });
  log('created new consumer', consumer);
  while (recvTransport.connectionState !== 'connected') {
    log('  transport connstate', recvTransport.connectionState );
    await sleep(100);
  }
  // okay, we're ready. let's ask the peer to send us media
  await resumeConsumer(consumer);
  consumers.push(consumer);

  await addVideoAudio(consumer);
  updatePeersDisplay();
  return consumer;
}

export async function unsubscribeFromTrack(peerId, mediaTag) {
  let consumer = findConsumerForTrack(peerId, mediaTag);
  if (!consumer) {
    return;
  }
  closeConsumer(consumer);
  updatePeersDisplay();
}

export async function pauseConsumer(consumer) {
  if (consumer) {
    await sig('pause-consumer', { consumerId: consumer.id });
    consumer.pause();
  }
}

export async function resumeConsumer(consumer) {
  if (consumer) {
    await sig('resume-consumer', { consumerId: consumer.id });
    consumer.resume();
  }
}

export async function pauseProducer(producer) {
  if (producer) {
    await sig('pause-producer', { producerId: producer.id });
    producer.pause();
  }
}

export async function resumeProducer(producer) {
  warn(`resume producer ${producer.id} ${producer.appData}`);
    await sig('resume-producer', { producerId: producer.id });
    producer.resume();
}

export async function producerStatsFromServer(producer) {
  warn(`get producer ${producer.id} stats from server`);
  let stats = await sig('producer-stats', { producerId: producer.id });
  return stats;
}

async function closeConsumer(consumer) {
  if (!consumer) {
    return;
  }
  log(`closing consumer ${consumer.id}`);
  consumers = consumers.filter((c) => c !== consumer);
  removeVideoAudio(consumer);
  // tell the server we're closing this consumer, even though the
  // server-side consumer may have been closed already
  sig('close-consumer', { consumerId: consumer.id });
  consumer.close();
}

//
// polling/update logic
//

async function pollAndUpdate() {
  let { peers, activeSpeaker, error } = await sig('sync');
  if (error) {
    return ({ error });
  }

  // always update bandwidth stats and active speaker display
  currentActiveSpeaker = activeSpeaker;
  updateActiveSpeaker();
  updateCamVideoProducerStatsDisplay();
  updateConsumersStatsDisplay();

  // decide if we need to update tracks list and video/audio
  // elements. build list of peers, sorted by join time, removing last
  // seen time and stats, so we can easily do a deep-equals
  // comparison. compare this list with the cached list from last
  // poll.
  let thisPeersList = sortPeers(peers),
      lastPeersList = sortPeers(lastPollSyncData);
  if (!deepEqual(thisPeersList, lastPeersList)) {
    updatePeersDisplay(peers, thisPeersList);
  }

  // if a peer has gone away, we need to close all consumers we have
  // for that peer and remove video and audio elements
  for (let id in lastPollSyncData) {
    if (!peers[id]) {
      log(`peer ${id} has exited`);
      consumers.forEach((consumer) => {
        if (consumer.appData.peerId === id) {
          closeConsumer(consumer);
        }
      });
    }
  }

  // if a peer has stopped sending media that we are consuming, we
  // need to close the consumer and remove video and audio elements
  consumers.forEach((consumer) => {
    let { peerId, mediaTag } = consumer.appData;
    if (!peers[peerId].media[mediaTag]) {
      log(`peer ${peerId} has stopped transmitting ${mediaTag}`);
      closeConsumer(consumer);
    }
  });

  lastPollSyncData = peers;
  return ({});
}

function sortPeers(peers) {
  return  Object.entries(peers)
    .map(([id, info]) => ({id, joinTs: info.joinTs, media: { ...info.media }}))
    .sort((a,b) => (a.joinTs>b.joinTs) ? 1 : ((b.joinTs>a.joinTs) ? -1 : 0));
}

function findConsumerForTrack(peerId, mediaTag) {
  return consumers.find((c) => (c.appData.peerId === peerId &&
                                c.appData.mediaTag === mediaTag));
}

//
// -- user interface --
//

export function getCamPausedState() {
  return !$('#local-cam-checkbox').checked;
}

export function getMicPausedState() {
  return !$('#local-mic-checkbox').checked;
}

export function getScreenPausedState() {
  return !$('#local-screen-checkbox').checked;
}

export async function changeCamPaused() {
  if (getCamPausedState()) {
    pauseProducer(camVideoProducer);
    $('#local-cam-label').innerHTML = 'camera (paused)';
  } else {
    resumeProducer(camVideoProducer);
    $('#local-cam-label').innerHTML = 'camera';
  }
}

export async function changeMicPaused() {
  if (getMicPausedState()) {
    pauseProducer(camAudioProducer);
    $('#local-mic-label').innerHTML = 'mic (paused)';
  } else {
    resumeProducer(camAudioProducer);
    $('#local-mic-label').innerHTML = 'mic';
  }
}

export async function changeScreenPaused() {
  if (getScreenPausedState()) {
    pauseProducer(screenVideoProducer);
    $('#local-screen-label').innerHTML = 'screen (paused)';
  } else {
    resumeProducer(screenVideoProducer);
    $('#local-screen-label').innerHTML = 'screen';
  }
}


export async function updatePeersDisplay(peersInfo = lastPollSyncData,
                                         sortedPeers = sortPeers(peersInfo)) {
  log('room state updated', peersInfo);

  $('#available-tracks').innerHTML = '';
  if (camVideoProducer) {
    $('#available-tracks')
      .appendChild(makeTrackControlEl('my', 'cam-video',
                                      peersInfo[myPeerId].media['cam-video']));
  }
  if (camAudioProducer) {
    $('#available-tracks')
      .appendChild(makeTrackControlEl('my', 'cam-audio',
                                      peersInfo[myPeerId].media['cam-audio']));
  }
  if (screenVideoProducer) {
    $('#available-tracks')
      .appendChild(makeTrackControlEl('my', 'screen-video',
                                    peersInfo[myPeerId].media['screen-video']));
  }

  for (let peer of sortedPeers) {
    if (peer.id === myPeerId) {
      continue;
    }
    for (let [mediaTag, info] of Object.entries(peer.media)) {
      $('#available-tracks')
        .appendChild(makeTrackControlEl(peer.id, mediaTag, info));
    }
  }
}

function makeTrackControlEl(peerName, mediaTag, mediaInfo) {
  let div = document.createElement('div'),
      peerId = (peerName === 'my' ? myPeerId : peerName),
      consumer = findConsumerForTrack(peerId, mediaTag);
  div.classList = `track-subscribe track-subscribe-${peerId}`;

  let sub = document.createElement('button');
  if (!consumer) {
    sub.innerHTML += 'subscribe'
    sub.onclick = () => subscribeToTrack(peerId, mediaTag);
    div.appendChild(sub);

  } else {
    sub.innerHTML += 'unsubscribe'
    sub.onclick = () => unsubscribeFromTrack(peerId, mediaTag);
    div.appendChild(sub);
  }

  let trackDescription = document.createElement('span');
  trackDescription.innerHTML = `${peerName} ${mediaTag}`
  div.appendChild(trackDescription);

  try {
    if (mediaInfo) {
      let producerPaused = mediaInfo.paused;
      let prodPauseInfo = document.createElement('span');
      prodPauseInfo.innerHTML = producerPaused ? '[producer paused]'
                                               : '[producer playing]';
      div.appendChild(prodPauseInfo);
    }
  } catch (e) {
    err(e);
  }

  if (consumer) {
    let pause = document.createElement('span'),
        checkbox = document.createElement('input'),
        label = document.createElement('label');
    pause.classList = 'nowrap';
    checkbox.type = 'checkbox';
    checkbox.checked = !consumer.paused;
    checkbox.onchange = async () => {
      if (checkbox.checked) {
        await resumeConsumer(consumer);
      } else {
        await pauseConsumer(consumer);
      }
      updatePeersDisplay();
    }
    label.id = `consumer-stats-${consumer.id}`;
    if (consumer.paused) {
      label.innerHTML = '[consumer paused]'
    } else {
      let stats = lastPollSyncData[myPeerId].stats[consumer.id],
          bitrate = '-';
      if (stats) {
        bitrate = Math.floor(stats.bitrate / 1000.0);
      }
      label.innerHTML = `[consumer playing ${bitrate} kb/s]`;
    }
    pause.appendChild(checkbox);
    pause.appendChild(label);
    div.appendChild(pause);

    if (consumer.kind === 'video') {
      let remoteProducerInfo = document.createElement('span');
      remoteProducerInfo.classList = 'nowrap track-ctrl';
      remoteProducerInfo.id = `track-ctrl-${consumer.producerId}`;
      div.appendChild(remoteProducerInfo);
    }
  }

  return div;
}

function addVideoAudio(consumer) {
  if (!(consumer && consumer.track)) {
    return;
  }
  let el = document.createElement(consumer.kind);
  // set some attributes on our audio and video elements to make
  // mobile Safari happy. note that for audio to play you need to be
  // capturing from the mic/camera
  if (consumer.kind === 'video') {
    el.setAttribute('playsinline', true);
  } else {
    el.setAttribute('playsinline', true);
    el.setAttribute('autoplay', true);
  }
  $(`#remote-${consumer.kind}`).appendChild(el);
  el.srcObject = new MediaStream([ consumer.track.clone() ]);
  el.consumer = consumer;
  // let's "yield" and return before playing, rather than awaiting on
  // play() succeeding. play() will not succeed on a producer-paused
  // track until the producer unpauses.
  el.play()
    .then(()=>{})
    .catch((e) => {
      err(e);
    });
}

function removeVideoAudio(consumer) {
  document.querySelectorAll(consumer.kind).forEach((v) => {
    if (v.consumer === consumer) {
      v.parentNode.removeChild(v);
    }
  });
}

async function showCameraInfo() {
  let deviceId = await getCurrentDeviceId(),
      infoEl = $('#camera-info');
  if (!deviceId) {
    infoEl.innerHTML = '';
    return;
  }
  let devices = await navigator.mediaDevices.enumerateDevices(),
      deviceInfo = devices.find((d) => d.deviceId === deviceId);
  infoEl.innerHTML = `
      ${ deviceInfo.label }
      <button onclick="Client.cycleCamera()">switch camera</button>
  `;
}

export async function getCurrentDeviceId() {
  if (!camVideoProducer) {
    return null;
  }
  let deviceId = camVideoProducer.track.getSettings().deviceId;
  if (deviceId) {
    return deviceId;
  }
  // Firefox doesn't have deviceId in MediaTrackSettings object
  let track = localCam && localCam.getVideoTracks()[0];
  if (!track) {
    return null;
  }
  let devices = await navigator.mediaDevices.enumerateDevices(),
      deviceInfo = devices.find((d) => d.label.startsWith(track.label));
  return deviceInfo.deviceId;
}

// --

async function createTransport(direction) {
  let { transportOptions } = await sig('create-transport', { direction });
  let transport;
  if (direction === 'recv') {
    transport = device.createRecvTransport(transportOptions);
  } else if (direction === 'send') {
    transport = device.createSendTransport(transportOptions);
  } else {
    throw new Error("bad transport 'direction': " + direction);
  }

  transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    let { error } = await sig('connect-transport', {
      transportId: transportOptions.id,
      dtlsParameters
    });
    if (error) {
      console.error('error in connect', error, transport);
      errback();
      return;
    }
    callback();
  });

  if (direction === 'send') {
    transport.on('produce', async ({ kind, rtpParameters, appData },
                                   callback, errback) => {
      let paused = false;
      if (appData.mediaTag === 'cam-video') {
        paused = getCamPausedState();
      } else if (appData.mediaTag === 'cam-audio') {
        paused = getMicPausedState();
      }
      let { error, id } = await sig('send-track', {
        transportId: transportOptions.id,
        kind,
        rtpParameters,
        paused,
        appData
      });
      if (error) {
        console.error(error);
        errback();
        return;
      }
      callback({ id });
    });
  }

  transport.on('connectionstatechange', async (state) => {
    log(`transport ${transport.id} connectionstatechange ${state}`);
    // for this simple sample code, assume that transports being
    // closed is an error (we never close these transports except when
    // we leave the room)
    if (state === 'closed' || state === 'failed' || state === 'disconnected') {
      leaveRoom();
    }
  });

  return transport;
}

//
//
//

function updateActiveSpeaker() {
  $$('.track-subscribe').forEach((el) => {
    el.classList.remove('active-speaker');
  });
  if (currentActiveSpeaker.peerId) {
    $$(`.track-subscribe-${currentActiveSpeaker.peerId}`).forEach((el) => {
      el.classList.add('active-speaker');
    });
  }
}

function updateCamVideoProducerStatsDisplay() {
  let tracksEl = $('#camera-producer-stats');
  tracksEl.innerHTML = '';
  if (!camVideoProducer || camVideoProducer.paused) {
    return;
  }
  makeProducerTrackSelector({
    internalTag: 'local-tracks',
    container: tracksEl,
    peerId: myPeerId,
    producerId: camVideoProducer.id,
    currentLayer: camVideoProducer.maxSpatialLayer,
    layerSwitchFunc: (i) => {
      console.log('client set layers');
      camVideoProducer.setMaxSpatialLayer(i) }
  });
}

function updateConsumersStatsDisplay() {
  try {
    for (let consumer of consumers) {
      let label = $(`#consumer-stats-${consumer.id}`);
      if (label) {
        if (consumer.paused) {
          label.innerHTML = '(consumer paused)'
        } else {
          let stats = lastPollSyncData[myPeerId].stats[consumer.id],
              bitrate = '-';
          if (stats) {
            bitrate = Math.floor(stats.bitrate / 1000.0);
          }
          label.innerHTML = `[consumer playing ${bitrate} kb/s]`;
        }
      }

      let mediaInfo = lastPollSyncData[consumer.appData.peerId] &&
                      lastPollSyncData[consumer.appData.peerId]
                        .media[consumer.appData.mediaTag];
      if (mediaInfo && !mediaInfo.paused) {
        let tracksEl = $(`#track-ctrl-${consumer.producerId}`);
        if (tracksEl && lastPollSyncData[myPeerId]
                               .consumerLayers[consumer.id]) {
          tracksEl.innerHTML = '';
          let currentLayer = lastPollSyncData[myPeerId]
                               .consumerLayers[consumer.id].currentLayer;
          makeProducerTrackSelector({
            internalTag: consumer.id,
            container: tracksEl,
            peerId: consumer.appData.peerId,
            producerId: consumer.producerId,
            currentLayer: currentLayer,
            layerSwitchFunc: (i) => {
              console.log('ask server to set layers');
              sig('consumer-set-layers', { consumerId: consumer.id,
                                           spatialLayer: i });
            }
          });
        }
      }
    }
  } catch (e) {
    log('error while updating consumers stats display', e);
  }
}

function makeProducerTrackSelector({ internalTag, container, peerId, producerId,
                                     currentLayer, layerSwitchFunc }) {
  try {
    let pollStats = lastPollSyncData[peerId] &&
                    lastPollSyncData[peerId].stats[producerId];
    if (!pollStats) {
      return;
    }

    let stats = [...Array.from(pollStats)]
                  .sort((a,b) => a.rid > b.rid ? 1 : (a.rid<b.rid ? -1 : 0));
    let i=0;
    for (let s of stats) {
      let div = document.createElement('div'),
          radio = document.createElement('input'),
          label = document.createElement('label'),
          x = i;
      radio.type = 'radio';
      radio.name = `radio-${internalTag}-${producerId}`;
      radio.checked = currentLayer == undefined ?
                          (i === stats.length-1) :
                          (i === currentLayer);
      radio.onchange = () => layerSwitchFunc(x);
      let bitrate = Math.floor(s.bitrate / 1000);
      label.innerHTML = `${bitrate} kb/s`;
      div.appendChild(radio);
      div.appendChild(label);
      container.appendChild(div);
      i++;
    }
    if (i) {
      let txt = document.createElement('div');
      txt.innerHTML = 'tracks';
      container.insertBefore(txt, container.firstChild);
    }
  } catch (e) {
    log('error while updating track stats display', e);
  }
}

//
// encodings for outgoing video
//

// just two resolutions, for now, as chrome 75 seems to ignore more
// than two encodings
const CAM_VIDEO_SIMULCAST_ENCODINGS =
[
	{ maxBitrate:  120000, scaleResolutionDownBy: 8 },
	// { maxBitrate: 300000, scaleResolutionDownBy: 2 },
  { maxBitrate: 680000, scaleResolutionDownBy: 1 },
];

function camEncodings() {
  // return null;
  return CAM_VIDEO_SIMULCAST_ENCODINGS;
}

function screenshareEncodings() {
  null;
}

//
// our "signaling" function.
//

async function sig(endpoint, data, beacon) {
  try {
    let headers = { 'Content-Type': 'application/json' },
        body = JSON.stringify({ ...data, peerId: myPeerId });

    if (beacon) {
      navigator.sendBeacon('/signaling/' + endpoint, body);
      return null;
    }

    let response = await fetch(
      '/signaling/' + endpoint, { method: 'POST', body, headers }
    );
    return await response.json();
  } catch (e) {
    console.error(e);
    return { error: e };
  }
}

//
// uuid helper function -
//   https://stackoverflow.com/questions/105034/create-guid-uuid-in-javascript
//
function uuidv4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  )
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(() => r(), ms));
}
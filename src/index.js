import React from 'react';
import PropTypes from 'prop-types';
import arrayFindIndex from 'array-find-index';
import classNames from 'classnames';

import PlayButtonImg from './play-button.svg'
import SkipNextImg from './skip.svg';
import PauseButtonImg from './pause.svg';
import Expender from './expender.svg';
import Close from './close.svg';
import './index.scss';

const deprecatedProps = [
  {
    name: 'hideBackSkip',
    alternativeMessage:
      'Exclude "backskip" from `controls` to hide the back skip button.'
  },
  {
    name: 'hideForwardSkip',
    alternativeMessage:
      'Exclude "forwardskip" from `controls` to hide the back skip button.'
  },
  {
    name: 'disableSeek',
    alternativeMessage:
      'Pass "progressdisplay" to `controls` (instead of "progress") ' +
        'for a non-seekable progress bar.'
  },
  {
    name: 'playlist[?].displayText',
    alternativeMessage:
      'Use `title` and `artist` to provide track information, and override ' +
        ' the `getDisplayText` function prop for custom display if needed.'
  }
];

const log = console.log.bind(console);
const logError = console.error ? console.error.bind(console) : log;
const logWarning = console.warn ? console.warn.bind(console) : log;

function getTokensForPropName (name) {
  // simple (imperfect) regex for splitting name into keys
  return name.split(/\.|\[|\]/).filter(token => token);
}

function doTokensMatchObject (tokens, object) {
  if (tokens.length === 0) {
    // for our purposes we can assume if we've exhausted the list,
    // then we were able to match the whole way down.
    return true;
  }
  const t = tokens[0];
  const nextTokens = tokens.slice(1);
  if (t === '?') { // wildcard - search all keys for a match
    return Object.keys(object).some(key => {
      return doTokensMatchObject(nextTokens, object[key]);
    });
  }
  return t in object && doTokensMatchObject(nextTokens, object[t]);
}

function findDeprecatedProps (props) {
  return deprecatedProps.filter(deprecated => {
    return doTokensMatchObject(getTokensForPropName(deprecated.name), props);
  });
}

const loggedDeprecations = [];
function logDeprecationWarnings (props) {
  for (const deprecated of findDeprecatedProps(props)) {
    if (loggedDeprecations.indexOf(deprecated.name) === -1) {
      logWarning(`
        The \`${deprecated.name}\` prop is deprecated. It will be removed
        in meuzic-player v2.0.0.
        ${deprecated.alternativeMessage}`);
      loggedDeprecations.push(deprecated.name);
    }
  }
}

let nextControlKey = 0;
function getNextControlKey () {
  return (nextControlKey++).toString();
}

/* converts given number of seconds to standard time display format
 * http://goo.gl/kEvnKn
 */
function convertToTime (number) {
  const mins = Math.floor(number / 60);
  const secs = (number % 60).toFixed();
  return `${ mins < 10 ? '0' : '' }${ mins }:${ secs < 10 ? '0' : '' }${ secs }`;
}

// Existing Media Session API implementations have default handlers
// for play/pause, and may yield unexpected behavior if custom
// play/pause handlers are defined - so let's leave them be.
const supportableMediaSessionActions = [
  'previoustrack',
  'nexttrack',
  'seekbackward',
  'seekforward'
];

// BEGIN PRIVATE CONTROL COMPONENTS

const SkipButton = ({ hidden, back, onClick }) => (
  <div
    id="skip_button"
    className={classNames('skip_button ', { hidden, back })}
    onClick={onClick}
  >
    <div className="skip_button_inner">
      <img src={SkipNextImg} alt="Skip Next" width="20" height="20"/>
    </div>
  </div>
);

const BackSkipButton = ({ audioPlayer }) => (
  <SkipButton
    audioPlayer={audioPlayer}
    hidden={audioPlayer.props.hideBackSkip}
    back={true}
    onClick={audioPlayer.backSkip}
  />
);

const ForwardSkipButton = ({ audioPlayer }) => (
  <SkipButton
    audioPlayer={audioPlayer}
    hidden={audioPlayer.props.hideForwardSkip}
    back={false}
    onClick={audioPlayer.skipToNextTrack}
  />
);

const PlayPauseButton = ({ audioPlayer }) => (
  <div
    id="play_pause_button"
    className={classNames('play_pause_button audio_button', {
      paused: audioPlayer.state.paused
    })}
    onClick={audioPlayer.togglePause}
  >
    <div className="play_pause_inner">
      {!audioPlayer.state.paused ? <img src={PauseButtonImg} alt="Play" width="25"/> : <img src={PlayButtonImg} alt="Play" width="25"/>}
    </div>
  </div>
);

const Spacer = () => <div className="spacer" />;

const AudioProgressDisplay = (props) => {
  return (
    <div className="audio_progress_container">
      <div
        id="audio_progress_container"
        className="audio_progress_bar"
        ref={props.onRef}
        onMouseDown={props.onMouseTouchStart}
        onTouchStart={props.onMouseTouchStart}
      >
        <div
          id="audio_progress"
          className="audio_progress"
          style={{ width: props.progressBarWidth }}>
        </div>
      </div>
      <div>
        <p className="elapsed_time">{props.elapsedTime}</p>
        <p className="full_time">{props.fullTime}</p>
      </div>
    </div>

  );
}

const AudioProgress = (props) => (
  <AudioProgressDisplay
    {...props}
    onMouseTouchStart={props.audioPlayer.adjustDisplayedTime}
    onRef={(ref) => props.audioPlayer.audioProgressContainer = ref}
  />
);

const keywordToControlComponent = {
  backskip: BackSkipButton,
  forwardskip: ForwardSkipButton,
  playpause: PlayPauseButton,
  spacer: Spacer,
  progressdisplay: AudioProgressDisplay,
  progress: AudioProgress
};

// END PRIVATE CONTROL COMPONENTS

class AudioPlayer extends React.Component {

  constructor (props) {
    super(props);

    /* true if the user is currently dragging the mouse
     * to seek a new track position
     */
    this.seekInProgress = false;
    // index matching requested track (whether track has loaded or not)
    this.currentTrackIndex = 0;

    this.defaultState = {
      /* activeTrackIndex will change to match
       * this.currentTrackIndex once metadata has loaded
       */
      activeTrackIndex: -1,
      // indicates whether audio player should be paused
      paused: true,
      /* elapsed time for current track, in seconds -
       * DISPLAY ONLY! the actual elapsed time may
       * not match up if we're currently seeking, since
       * the new time is visually previewed before the
       * audio seeks.
       */
      displayedTime: 0,
      palyer : true // ON
    };

    this.state = this.defaultState;

    // set of keys to use in controls render
    this.controlKeys = props.controls.map(getNextControlKey);

    // html audio element used for playback
    this.audio = null;
    this.audioProgressContainer = null;

    // event listeners to add on mount and remove on unmount
    this.setAudioElementRef = this.setAudioElementRef.bind(this);
    this.backSkip = this.backSkip.bind(this);
    this.skipToNextTrack = this.skipToNextTrack.bind(this);
    this.togglePause = this.togglePause.bind(this);
    this.adjustDisplayedTime = this.adjustDisplayedTime.bind(this);
    this.seekReleaseListener = e => this.seek(e);
    this.audioPlayListener = () => {
      this.setState({ paused: false });
      this.stealMediaSession();
    };
    this.audioPauseListener = () => this.setState({ paused: true });
    this.audioEndListener = () => {
      const gapLengthInSeconds = this.props.gapLengthInSeconds || 0;
      clearTimeout(this.gapLengthTimeout);
      this.gapLengthTimeout = setTimeout(() => this.skipToNextTrack(), gapLengthInSeconds * 1000);
    };
    this.audioStallListener = () => this.togglePause(true);
    this.audioTimeUpdateListener = () => this.handleTimeUpdate();
    this.audioMetadataLoadedListener = () => this.setState({
      activeTrackIndex: this.currentTrackIndex
    });
    this.expend = this.expend.bind(this);
    this.closePlayer = this.closePlayer.bind(this);
  }

  componentDidMount () {
    logDeprecationWarnings(this.props);

    // add event listeners bound outside the scope of our component
    window.addEventListener('mousemove', this.adjustDisplayedTime);
    document.addEventListener('touchmove', this.adjustDisplayedTime);
    window.addEventListener('mouseup', this.seekReleaseListener);
    document.addEventListener('touchend', this.seekReleaseListener);

    const audio = this.audio;

    // add event listeners on the audio element
    audio.preload = 'metadata';
    audio.addEventListener('play', this.audioPlayListener);
    audio.addEventListener('pause', this.audioPauseListener);
    audio.addEventListener('ended', this.audioEndListener);
    audio.addEventListener('stalled', this.audioStallListener);
    audio.addEventListener('timeupdate', this.audioTimeUpdateListener);
    audio.addEventListener('loadedmetadata', this.audioMetadataLoadedListener);
    this.addMediaEventListeners(this.props.onMediaEvent);

    if (this.props.playlist && this.props.playlist.length) {
      this.updateSource();
      if (this.props.autoplay) {
        const delay = this.props.autoplayDelayInSeconds || 0;
        clearTimeout(this.delayTimeout);
        this.delayTimeout = setTimeout(() => this.togglePause(false), delay * 1000);
      }
    }
  }

  componentWillUnmount () {
    // remove event listeners bound outside the scope of our component
    window.removeEventListener('mousemove', this.adjustDisplayedTime);
    document.removeEventListener('touchmove', this.adjustDisplayedTime);
    window.removeEventListener('mouseup', this.seekReleaseListener);
    document.removeEventListener('touchend', this.seekReleaseListener);

    // remove event listeners on the audio element
    this.audio.removeEventListener('play', this.audioPlayListener);
    this.audio.removeEventListener('pause', this.audioPauseListener);
    this.audio.removeEventListener('ended', this.audioEndListener);
    this.audio.removeEventListener('stalled', this.audioStallListener);
    this.audio.removeEventListener('timeupdate', this.audioTimeUpdateListener);
    this.audio.removeEventListener('loadedmetadata', this.audioMetadataLoadedListener);
    this.removeMediaEventListeners(this.props.onMediaEvent);
    clearTimeout(this.gapLengthTimeout);
    clearTimeout(this.delayTimeout);

    // pause the audio element before we unmount
    this.audio.pause();
  }

  componentWillReceiveProps (nextProps) {
    logDeprecationWarnings(nextProps);

    // Update media event listeners that may have changed
    this.removeMediaEventListeners(this.props.onMediaEvent);
    this.addMediaEventListeners(nextProps.onMediaEvent);

    const oldControls = [...this.props.controls];
    this.controlKeys = nextProps.controls.map(control => {
      const matchingIndex = oldControls.indexOf(control);
      if (matchingIndex !== -1 && oldControls[matchingIndex]) {
        oldControls[matchingIndex] = null;
        return this.controlKeys[matchingIndex];
      }
      return getNextControlKey();
    });

    const newPlaylist = nextProps.playlist;
    if (!newPlaylist || !newPlaylist.length) {
      if (this.audio) {
        this.audio.src = '';
      }
      this.currentTrackIndex = 0;
      return this.setState(this.defaultState);
    }

    const oldPlaylist = this.props.playlist;

    const currentTrackUrl = ((oldPlaylist || [])[this.currentTrackIndex] || {}).url;
    this.currentTrackIndex = arrayFindIndex(newPlaylist, track => {
      return track.url && currentTrackUrl === track.url;
    });
    /* if the track we're already playing is in the new playlist, update the
     * activeTrackIndex.
     */
    if (this.currentTrackIndex !== -1) {
      this.setState({
        activeTrackIndex: this.currentTrackIndex
      });
    }
  }

  addMediaEventListeners (mediaEvents) {
    if (!mediaEvents) {
      return;
    }
    Object.keys(mediaEvents).forEach((type) => {
      if (typeof mediaEvents[type] !== 'function') {
        return;
      }
      this.audio.addEventListener(type, mediaEvents[type]);
    });
  }

  removeMediaEventListeners (mediaEvents) {
    if (!mediaEvents) {
      return;
    }
    Object.keys(mediaEvents).forEach((type) => {
      if (typeof mediaEvents[type] !== 'function') {
        return;
      }
      this.audio.removeEventListener(type, mediaEvents[type]);
    });
  }

  componentDidUpdate (prevProps) {
    /* if we loaded a new playlist and reset the current track marker, we
     * should load up the first one.
     */
    if (this.currentTrackIndex === -1) {
      this.skipToNextTrack(false);
    }
    if (prevProps !== this.props && !this.audio.paused) {
      // update running media session based on new props
      this.stealMediaSession();
    }
  }

  setAudioElementRef (ref) {
    this.audio = ref;
    if (typeof this.props.audioElementRef === 'function') {
      this.props.audioElementRef(this.audio);
    }
  }

  stealMediaSession () {
    if (!(window.MediaSession && navigator.mediaSession instanceof MediaSession)) {
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata(
      this.props.playlist[this.currentTrackIndex]
    );
    supportableMediaSessionActions.map(action => {
      if (this.props.supportedMediaSessionActions.indexOf(action) === -1) {
        return null;
      }
      const seekLength = this.props.mediaSessionSeekLengthInSeconds;
      switch (action) {
        case 'play':
          return this.togglePause.bind(this, false);
        case 'pause':
          return this.togglePause.bind(this, true);
        case 'previoustrack':
          return this.backSkip;
        case 'nexttrack':
          return this.skipToNextTrack;
        case 'seekbackward':
          return () => this.audio.currentTime -= seekLength;
        case 'seekforward':
          return () => this.audio.currentTime += seekLength;
        default:
          return undefined;
      }
    }).forEach((handler, i) => {
      navigator.mediaSession.setActionHandler(
        supportableMediaSessionActions[i],
        handler
      );
    });
  }

  togglePause (value) {
    if (!this.audio) {
      return;
    }
    const pause = typeof value === 'boolean' ? value : !this.state.paused;
    if (pause) {
      return this.audio.pause();
    }
    if (!this.props.playlist || !this.props.playlist.length) {
      return;
    }
    try {
      this.audio.play();
    } catch (error) {
      logError(error);
      const warningMessage =
        'Audio playback failed at ' +
        new Date().toLocaleTimeString() +
        '! (Perhaps autoplay is disabled in this browser.)';
      logWarning(warningMessage);
    }
  }

  skipToNextTrack (shouldPlay) {
    if (!this.audio) {
      return;
    }
    if (!this.props.playlist || !this.props.playlist.length) {
      return;
    }
    let i = this.currentTrackIndex + 1;
    if (i >= this.props.playlist.length) {
      i = 0;
    }
    this.currentTrackIndex = i;
    const shouldPauseOnCycle = !this.props.cycle && this.currentTrackIndex === 0;
    const shouldPause = shouldPauseOnCycle || (typeof shouldPlay === 'boolean' ? !shouldPlay : false);
    if (shouldPause) {
      this.togglePause(true);
    }
    this.setState({
      activeTrackIndex: -1,
      displayedTime: 0
    }, () => {
      setTimeout(() => {
        // run asynchronously so "pause" event has time to process
        this.updateSource();
        if (!shouldPause) {
          this.togglePause(false);
        }
      });
    });
  }

  backSkip () {
    if (!this.props.playlist || !this.props.playlist.length) {
      return;
    }
    const audio = this.audio;
    let stayOnBackSkipThreshold = this.props.stayOnBackSkipThreshold;
    if (isNaN(stayOnBackSkipThreshold)) {
      stayOnBackSkipThreshold = 5;
    }
    if (audio.currentTime >= stayOnBackSkipThreshold) {
      return audio.currentTime = 0;
    }
    let i = this.currentTrackIndex - 1;
    if (i < 0) {
      i = this.props.playlist.length - 1;
    }
    this.currentTrackIndex = i - 1;
    this.skipToNextTrack();
  }

  updateSource () {
    this.audio.src = this.props.playlist[this.currentTrackIndex].url;
  }

  handleTimeUpdate () {
    if (!this.seekInProgress && this.audio) {
      this.setState({
        displayedTime: this.audio.currentTime
      });
    }
  }

  adjustDisplayedTime (event) {
    if (!this.props.playlist || !this.props.playlist.length || this.props.disableSeek) {
      return;
    }
    // make sure we don't select stuff in the background while seeking
    if (event.type === 'mousedown' || event.type === 'touchstart') {
      this.seekInProgress = true;
      document.body.classList.add('noselect');
    } else if (!this.seekInProgress) {
      return;
    }
    /* we don't want mouse handlers to receive the event
     * after touch handlers if we're seeking.
     */
    event.preventDefault();
    const boundingRect = this.audioProgressContainer.getBoundingClientRect();
    const isTouch = event.type.slice(0, 5) === 'touch';
    const pageX = isTouch ? event.targetTouches.item(0).pageX : event.pageX;
    const position = pageX - boundingRect.left - document.body.scrollLeft;
    const containerWidth = boundingRect.width;
    const progressPercentage = Math.max(0, Math.min(1, position / containerWidth));
    this.setState({
      displayedTime: progressPercentage * this.audio.duration
    });
  }

  seek (event) {
    /* this function is activated when the user lets
     * go of the mouse, so if .noselect was applied
     * to the document body, get rid of it.
     */
    document.body.classList.remove('noselect');
    if (!this.seekInProgress) {
      return;
    }
    /* we don't want mouse handlers to receive the event
     * after touch handlers if we're seeking.
     */
    event.preventDefault();
    this.seekInProgress = false;
    const displayedTime = this.state.displayedTime;
    if (isNaN(displayedTime)) {
      return;
    }
    this.audio.currentTime = displayedTime;
  }

  expend(){
    this.setState({expend : true})
  }

  closePlayer(){
    this.setState({palyer : false})
  }

  render () {
    let activeIndex = this.state.activeTrackIndex;
    let displayText = this.props.getDisplayText(this.props.playlist[activeIndex]);
    let artwork =this.props.getArtwork(this.props.playlist[activeIndex])
    let album = this.props.getAlbumName(this.props.playlist[activeIndex])
    let displayedTime = this.state.displayedTime;
    let duration = this.audio && this.audio.duration || 0;
    let elapsedTime = convertToTime(displayedTime);
    let fullTime = convertToTime(duration);
    let timeRatio = `${ elapsedTime } / ${ fullTime }`;
    let progressBarWidth = `${ (displayedTime / duration) * 100 }%`;
    let commonProps = { displayText, timeRatio,elapsedTime, fullTime ,progressBarWidth, audioPlayer: this };

    if(!this.state.palyer) {
      return false
    }

    return (
      <div>
        <div
          id="audio_player"
          className={'audio_player'}
          title={displayText}
        >
          <div className="audio_player_close">
            <img onClick={this.closePlayer} src={Close} alt="Close" width="15" height="15"/>
          </div>
          <div className="track_details">
            <audio ref={this.setAudioElementRef} />
            <div className="track_info">
              <div className="track_artwork">
                <img src={artwork} alt={displayText} width="100"/>
              </div>
              <div className="track_name">
                <div className="track_title">{displayText}</div>
                <div className="track_album">{album}</div>
              </div>
            </div>
            <div>
              <AudioProgress {...commonProps} />
            </div>
            <div className="audio_controls">
              <BackSkipButton {...commonProps}/> <PlayPauseButton {...commonProps} /> <ForwardSkipButton {...commonProps}/>
            </div>
          </div>
        </div>
      </div>
    );
  }

}

AudioPlayer.propTypes = {
  playlist: PropTypes.array,
  controls: PropTypes.arrayOf(PropTypes.oneOf([
    'playpause',
    'backskip',
    'forwardskip',
    'progress',
    'progressdisplay',
    'spacer'
  ])),
  autoplay: PropTypes.bool,
  autoplayDelayInSeconds: PropTypes.number,
  gapLengthInSeconds: PropTypes.number,
  hideBackSkip: PropTypes.bool,
  hideForwardSkip: PropTypes.bool,
  cycle: PropTypes.bool,
  disableSeek: PropTypes.bool,
  stayOnBackSkipThreshold: PropTypes.number,
  supportedMediaSessionActions: PropTypes.arrayOf(PropTypes.oneOf([
    'play',
    'pause',
    'previoustrack',
    'nexttrack',
    'seekbackward',
    'seekforward'
  ]).isRequired).isRequired,
  mediaSessionSeekLengthInSeconds: PropTypes.number.isRequired,
  getDisplayText: PropTypes.func.isRequired,
  style: PropTypes.object,
  onMediaEvent: PropTypes.object,
  audioElementRef: PropTypes.func
};

AudioPlayer.defaultProps = {
  cycle: true,
  controls: [
    'spacer',
    'backskip',
    'playpause',
    'forwardskip',
    'spacer',
    'progress'
  ],
  supportedMediaSessionActions: [
    'play',
    'pause',
    'previoustrack',
    'nexttrack'
  ],
  mediaSessionSeekLengthInSeconds: 10,
  getDisplayText: function getDisplayText (track) {
    if (!track) {
      return '';
    }
    if (track.displayText) {
      // TODO: Remove this check when support for the displayText prop is gone.
      return track.displayText;
    }
    if (track.title && track.artist) {
      return `${track.artist} - ${track.title}`;
    }
    return track.title || track.artist || track.album || '';
  },
  getArtwork : function getArtwork(track) {
    if(!track) return;
    if(track.artwork) return track.artwork;
    else return 'http://via.placeholder.com/350x350';
  },
  getAlbumName : function getAlbumName(track){
    if(!track) return;
    if(track.album) return track.album;
    else return '';
  }
};

module.exports = AudioPlayer;

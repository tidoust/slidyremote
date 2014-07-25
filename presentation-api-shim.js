/**
 * @fileOverview Shim for the latest version of the Presentation API [1] that
 * aims to support projecting to Chromecast devices, to attached devices (HDMI,
 * Miracast, etc.) through the experimental Chromium build [2] and to a separate
 * browser window as a fallback.
 *
 * Support for Chromecast devices is heavily restrained because Cast receiver
 * applications need to be registered with Google before they may be used and
 * this code needs to know about the mapping between the URL of the application
 * and the application ID provided by Google upon registration.
 *
 * As such, applications that want to make use of the shim on Google Cast
 * devices need first to issue a call to:
 *  navigator.presentation.registerCastApplication(appUrl, appId)
 *
 * Other restrictions:
 * - the code uses Promises, underlying Web browser needs to support them
 * - support for custom events is fairly limited. Only the "on" properties
 * are supported to attach to events on exposed objects, no way to use
 * "addEventListener" for the time being.
 * - The Cast sender library [3] needs to be loaded before that code if one
 * wants to support Chromecast devices.
 * - the "onavailablechange" event is not implemented
 * - the code probably does not properly handle cases where the receiver calls
 *  "session.close()". Not exactly sure what to do there.
 *
 * The code below is divided in 3 parts:
 *  a) the definition of the CastPresentationSession class that implements
 *     the PresentationSession interface on top of the Google Cast API
 *  b) the definition of the WindowPresentationSession class that implements
 *     the PresentationSession interface on top of window.open
 *  c) the actual definition of "navigator.presentation" and of the
 *     PresentationSession class that dispatches the request to either
 *     CastPresentationSession or WindowPresentationSession depending on
 *     the underlying context
 * The first two parts could be moved to their own JS file, modules are not
 * used here not to have to introduce dependencies to some module loader
 * library.
 *
 * References:
 * [1] http://webscreens.github.io/presentation-api/
 * [2] http://webscreens.github.io/demo/#binaries
 * [3] https://www.gstatic.com/cv/js/sender/v1/cast_sender.js
 */
(function () {
  /**********************************************************************
  Simple console logger to help with debugging. Caller may change logging
  level by setting navigator.presentationLogLevel to one of "log", "info",
  "warn", "error" or "none" (or null which also means "none").

  Note this should be done before that shim is loaded!
  **********************************************************************/
  var log = function () {
    var presentationLogLevel = navigator.presentationLogLevel || 'none';
    if ((presentationLogLevel === 'none') || (arguments.length === 0)) {
      return;
    }

    var level = arguments[0];
    var params = null;
    if ((level === 'log') ||
        (level === 'info') ||
        (level === 'warn') ||
        (level === 'error')) {
      // First parameter is the log level
      params = Array.prototype.slice.call(arguments, 1);
    }
    else {
      // No log level provided, assume "log"
      level = 'log';
      params = Array.prototype.slice.call(arguments);
    }
    if ((level === 'error') ||
        ((level === 'warn') &&
          (presentationLogLevel !== 'error')) ||
        ((level === 'info') &&
          (presentationLogLevel !== 'error') &&
          (presentationLogLevel !== 'warn')) ||
        ((level === 'log') &&
          (presentationLogLevel === 'log'))) {
      console[level].apply(console, params);
    }
  };


  /**********************************************************************
  Exposes a CastPresentationSession class that implements the
  PresentationSession interface on top of the Google Cast API and lets one
  request display of Web content on available Google Cast devices.

  The class exposes 2 static methods that return Promises:
    1. "create": returns the Promise to get a new PresentationSession for the
    requested Web content if possible.
    2. "startReceiver": returns a Promise to get a PresentationSession if
    the code is running within a Google Cast receiver application.

  The class also exposes the "registerCastApplication" static function to
  register the mapping between a receiver app URL and its Google Cast ID.
  **********************************************************************/
  var CastPresentationSession = (function () {
    /**
     * Whether the Cast API library is available or not.
     * If it's not, the Promises returned by "create" and "startReceiver"
     * will always end up being rejected.
     */
    var castApiAvailable = false;
    window['__onGCastApiAvailable'] = function (loaded, errorInfo) {
      if (loaded) {
        log('Google Cast API library is available and loaded');
        castApiAvailable = true;
      } else {
        log('warn',
          'Google Cast API library is available but could not be loaded',
          errorInfo);
      }
    };


    /**
     * Whether the Cast API library has been initialized.
     *
     * That flag is used to support multiple calls to "requestSession". Once
     * the Cast API library has been initialized, subsequent Cast session
     * requests should directly call sessionRequest.
     */
    var castApiInitialized = false;


    /**
     * Mapping table between receiver application URLs and Cast application IDs
     *
     * Ideally, there should not be any need to maintain such a mapping table
     * but there is no way to have an arbitrary URL run on a Chromecast device.
     */
    var castApplications = {};


    /**
     * Wraps an inner Google Cast session, expose useful properties and methods
     * for that session to be used within a PresentationSession.
     *
     * @constructor
     * @param {String} url Receiver application URL
     * @param {chrome.cast.Session} session The running Cast session to wrap
     * @implements {PresentationSession}
     */
    var CastPresentationSession = function (url, session) {
      this.url = url;
      this.state = 'connected';
      this.onstatechange = null;
      this.onmessage = null;
      this.session = session;

      var that = this;
      this.session.addUpdateListener(function (isAlive) {
        that.state = isAlive ? 'connected' : 'disconnected';
        log('received Cast session state update', 'isAlive=' + isAlive);
        if (that.onstatechange) {
          that.onstatechange(that.state);
        }
      });

      var namespace = this.session.namespaces[0];
      this.session.addMessageListener(namespace, function (namespace, message) {
        log('received message from Cast receiver', message);
        if (that.onmessage) {
          that.onmessage(message);
        }
      });
    };


    /**
     * Sends a message to the Google Cast device.
     *
     * @function
     * @param {Object} message
     */
    CastPresentationSession.prototype.postMessage = function (message) {
      if (this.state !== 'connected') {
        return;
      }
      log('post message to Cast receiver', message);
      var namespace = this.session.namespaces[0];
      this.session.sendMessage(namespace.name, message);
    };


    /**
     * Close the Cast session
     *
     * @function
     */
    CastPresentationSession.prototype.close = function () {
      if (this.state !== 'connected') {
        return;
      }
      log('close Cast session');
      this.session.stop();
    };


    /**
     * Registers the equivalence between the URL of a receiver application and
     * its Google Cast app ID.
     *
     * @function
     * @static
     * @param {String} url URL of the receiver application
     * @param {String} id The Cast application ID associated with that URL
     */
    CastPresentationSession.registerCastApplication = function (url, id) {
      castApplications[url] = id;
    };


    /**
     * Creates a Google Cast session for the given presentation URL
     *
     * @function
     * @static
     * @param {String} url The URL of the receiver app to run
     * @return {Promise} The promise to have a running Cast session
     */
    CastPresentationSession.create = function (url) {
      return new Promise(function (resolve, reject) {
        if (!castApiAvailable) {
          log('cannot create Cast session',
            'Google Cast API library is not available');
          reject();
          return;
        }

        if (!castApplications[url]) {
          log('cannot create Cast session',
            'no receiver app known for url', url);
          reject();
          return;
        }

        var sessionCreated = false;
        var applicationId = castApplications[url];
        var sessionRequest = new chrome.cast.SessionRequest(applicationId);

        var requestSession = function () {
          log('request new Cast session for url', url);
          chrome.cast.requestSession(function (session) {
            log('got a new Cast session');
            sessionCreated = true;
            resolve(new CastPresentationSession(url, session));
          }, function (error) {
            if (sessionCreated) {
              return;
            }
            if (error.code === 'cancel') {
              log('info', 'user chose not to use Cast device');
            }
            else if (error.code === 'receiver_unavailable') {
              log('info', 'no compatible Cast device found');
            }
            else {
              log('error', 'could not create Cast session', error);
            }
            reject();
          }, sessionRequest);
        };

        var apiConfig = new chrome.cast.ApiConfig(
          sessionRequest,
          function sessionListener(session) {
            // Method called at most once after initialization if a running
            // Cast session may be resumed
            log('found existing Cast session, reusing');
            sessionCreated = true;
            resolve(new CastPresentationSession(url, session));
          },
          function receiverListener(available) {
            // Method called whenever the number of Cast devices available in
            // the local network changes. The method is called at least once
            // after initialization. We're interested in that first call.
            if (sessionCreated) {
              return;
            }

            // Reject creation if there are no Google Cast devices that
            // can handle the application.
            if (available !== chrome.cast.ReceiverAvailability.AVAILABLE) {
              log('cannot create Cast session',
                'no Cast device available for url', url);
              reject();
            }

            log('found at least one compatible Cast device');
            requestSession();
          });

        if (castApiInitialized) {
          // The Cast API library has already been initialized, call
          // requestSession directly.
          log('Google Cast API library already initialized',
            'request new Cast session');
          requestSession();
        }
        else {
          // The Cast API library first needs to be initialized
          log('initialize Google Cast API library for url', url);
          chrome.cast.initialize(apiConfig, function () {
            // Note actual session creation is handled by callback functions
            // defined above
            log('Google Cast API library initialized');
            castApiInitialized = true;
          }, function (err) {
            log('error',
              'Google Cast API library could not be initialized', err);
            reject();
            return;
          });
        }
      });
    };


    /**
     * Starts the Google Cast receiver code if needed, in other words if the
     * code is running on a Google Cast device.
     *
     * @function
     * @static
     * @return {Promise} The promise to get a running PresentationSession if
     *   the code is running within a receiver app on a Google Cast device.
     *   The promise is rejected if the code is not running on such a device.
     */
    CastPresentationSession.startReceiver = function () {
      return new Promise(function (resolve, reject) {
        // Detect whether the code is running on a Google Cast device. If it is,
        // it means the code is used within a Receiver application and was
        // launched as the result of a call to:
        //   navigator.presentation.requestSession
        // NB: no better way to tell whether we're running on a Cast device
        // for the time being, see:
        // https://code.google.com/p/google-cast-sdk/issues/detail?id=157
        var runningOnChromecast = !!window.navigator.userAgent.match(/CrKey/);
        if (!runningOnChromecast) {
          log('code is not running on a Google Cast device');
          reject();
          return;
        }

        // Start the Google Cast receiver
        // Note the need to create the CastReceiverSession before the call to
        // "start", as that class registers the namespace used for the
        // communication channel.
        log('code is running on a Google Cast device',
          'start Google Cast receiver manager');
        var castReceiverManager = cast.receiver.CastReceiverManager.getInstance();
        var session = new CastReceiverSession(castReceiverManager);
        castReceiverManager.start();
        castReceiverManager.onReady = function () {
          log('Google Cast receiver manager started');
          resolve(session);
        };

        // TODO: reject the Promise if the call to "start" fails (not sure
        // which event to listen to though)
      });
    };


    /**
     * Presentation session that handles the case when the app is a receiver
     * app running on a Google Cast Cast device.
     *
     * Note the external world does not need to know about the existence of
     * that class. It merely needs to know it may receive a PresentationSession
     * instance from the "startReceiver" method.
     *
     * @constructor
     * @param {chrome.cast.CastReceiverManager} castReceiverManager The Cast
     *   receiver manager singleton
     * @implements {PresentationSession}
     */
    var CastReceiverSession = function (castReceiverManager) {
      this.state = 'connected';
      this.onmessage = null;
      this.onstatechange = null;

      this.castReceiverManager = castReceiverManager;
      this.customMessageBus = castReceiverManager.getCastMessageBus(
        'urn:x-cast:org.w3.webscreens.presentationapi.shim',
        cast.receiver.CastMessageBus.MessageType.JSON);

      var that = this;
      this.customMessageBus.addEventListener('message', function (event) {
        log('received message from Cast sender', event.data);
        if (that.onmessage) {
          that.onmessage(event.data);
        }
      });
    };


    /**
     * Posts a message from a Cast receiver session to the sender.
     *
     * Note current implementation does not support multiple senders and
     * will just broadcast the message to all connected senders.
     *
     * @function
     * @param {Object} message Message to change
     */
    CastReceiverSession.prototype.postMessage = function (message) {
      if (this.state !== 'connected') {
        return;
      }
      log('post message to Cast sender', message);
      this.customMessageBus.broadcast(message);
    };


    /**
     * Closes the receiver session
     *
     * TODO: this actually kills the application. Not really sure what the
     * function should do instead: close the communication channel? That would
     * leave the presentation session running on the Cast device without
     * controller.
     *
     * @function
     */
    CastReceiverSession.prototype.close = function () {
      if (this.state !== 'connected') {
        return;
      }
      log('stop Cast receiver manager');
      this.state = 'disconnected';
      this.castReceiverManager.stop();
    };


    // Expose the CastPresentationSession class to the external world
    return CastPresentationSession;
  })();



  /**********************************************************************
  Exposes an WindowPresentationSession class that implements the
  PresentationSession interface on top of "window.open" and lets one
  request display of Web content on second screens connected through a
  video port or some wireless equivalent (e.g. Miracast, WiDi) provided
  that the code runs in the appropriate modified version of Chromium
  that adds support to the "presentation" parameter of "window.open".

  If the code is not running in the appropriate build of Chromium, the
  presentation session simply opens in a separate window on the same
  screen.

  The class exposes 2 static methods that return Promises:
    1. "create": returns the Promise to get a new PresentationSession for
    the requested Web content if possible.
    2. "startReceiver": returns a Promise to get a PresentationSession if
    the code is running in a receiver app. Note the Promise may never be
    resolved in practice as the code will wait for the opener window to
    send a "presentation" message.
  **********************************************************************/
  var WindowPresentationSession = (function () {
    /**
     * Represents a session to some attached screen, meaning a session to a
     * secondary browsing context created and maintained by the current user
     * agent
     *
     * @constructor
     * @param {window} remoteWindow Pointer to the remote window
     */
    var WindowPresentationSession = function (remoteWindow) {
      this.state = 'connected';
      this.onmessage = null;
      this.onstatechange = null;
      this.remoteWindow = remoteWindow;

      var that = this;

      window.addEventListener('message', function (event) {
        if (event.source === remoteWindow) {
          if (event.data === 'receivershutdown') {
            log('received shut down message from presentation window',
              'disconnect session');
            that.state = 'disconnected';
            if (that.onstatechange) {
              that.onstatechange(that.state);
            }
          }
          else {
            log('received message from presentation window', event.data);
            if (that.onmessage) {
              that.onmessage(event.data);
            }
          }
        }
      }, false);
    };


    /**
     * Sends a message to the attached screen
     *
     * @function
     * @param {String} msg
     */
    WindowPresentationSession.prototype.postMessage = function (msg) {
      if (this.state !== 'connected') {
        return;
      }
      log('post message to presentation window', msg);
      this.remoteWindow.postMessage(msg, '*');
    };


    /**
     * Closes the attached session
     *
     * @function
     */
    WindowPresentationSession.prototype.close = function () {
      if (this.state !== 'connected') {
        return;
      }
      log('close presentation window');
      this.remoteWindow.close();
      this.state = 'disconnected';
      if (this.onstatechange) {
        this.onstatechange(this.state);
      }
    };


    /**
     * Create a presentation session for the first attached screen, falling
     * back to a separate window if there are none.
     *
     * @function
     * @param {String} url The URL to load in the presentation session
     * @return {Promise} The promise to get a WindowPresentationSession instance
     */
    WindowPresentationSession.create = function (url) {
      return new Promise(function (resolve, reject) {
        log('open presentation window');
        var presentationWindow = window.open(url, '', 'presentation');
        if (!presentationWindow) {
          log('could not open presentation window');
          reject();
          return;
        }

        window.addEventListener('message', function (event) {
          if ((event.source === presentationWindow) &&
              (event.data === 'ispresentation')) {
            log('received "is this a presentation session?" message ' +
              'from presentation window');
            log('post "presentation" message to presentation window');
            presentationWindow.postMessage('presentation', '*');
          }
          else if ((event.source === presentationWindow) &&
              (event.data === 'presentationready')) {
            log('received "presentation ready" message ' +
              'from presentation window');
            resolve(new WindowPresentationSession(presentationWindow));
          }
        }, false);
      });
    };


    /**
     * Prepares a PresentationSession if the code is running within a
     * receiver application.
     *
     * To determine whether that is the case, the code dispatches a
     * "ispresentation" message to its opener window (if defined) and
     * waits for a "presentation" ack from that opener window.
     *
     * @function
     * @static
     * @return {Promise} The promise to get a running PresentationSession if
     *   the code is running within a receiver app on a Google Cast device.
     *   The promise is rejected if the code is not running on such a device.
     */
    WindowPresentationSession.startReceiver = function () {
      return new Promise(function (resolve, reject) {
        // No window opener? The code does not run a receiver app.
        if (!window.opener) {
          log('code is not running in a presentation window');
          reject();
          return;
        }

        var messageEventListener = function (event) {
          if ((event.source === window.opener) &&
              (event.data === 'presentation')) {
            log('received "presentation" message from opener window');
            log('code is running in a presentation window');
            window.removeEventListener('message', messageEventListener);
            resolve(new WindowPresentationSession(window.opener));
          }
        };

        window.addEventListener('message', messageEventListener, false);
        window.addEventListener('load', function () {
          log('post "ispresentation" message to opener window ' +
            'and wait for "presentation" message');
          log('assume code is not running in a presentation window ' +
            'in the meantime');
          window.opener.postMessage('ispresentation', '*');
        }, false);
        window.addEventListener('unload', function () {
          log('presentation window is being closed');
          if (window.opener) {
            window.opener.postMessage('receivershutdown', '*');
          }
        }, false);
      });
    };


    // Expose the WindowPresentationSession to the external world
    return WindowPresentationSession;
  })();



  /**********************************************************************
  Implements navigator.presentation, dispatching to
  CastPresentationSession or WindowPresentationSession depending on
  the underlying context.
  **********************************************************************/

  /**
   * Implements a generic Presentation session that dispatches to either
   * CastPresentationSession or WindowPresentationSession depending on
   * the underlying context.
   *
   * @constructor
   * @param {String} url URL of the application to project to a second screen
   */
  var PresentationSession = function (url) {
    this.url = url;
    this.session = null;
    this.state = 'disconnected';
    this.onmessage = null;
    this.onstatechange = null;

    // Try with a Google Cast presentation session first,
    // then with a window presentation session.
    log('info', 'new presentation session requested for url', url);
    log('try to create a Cast session');
    var that = this;
    CastPresentationSession.create(url)
      .then(function (session) {
        log('Cast presentation session created');
        return session;
      }, function () {
        log('Cast session could not be created');
        log('try to create a presentation window instead');
        return WindowPresentationSession.create(url);
      })
      .then(function (session) {
        log('info', 'presentation session created');
        that.session = session;
        that.state = session.state;
        that.session.onmessage = function (message) {
          if (that.onmessage) {
            that.onmessage(message);
          }
        };
        that.session.onstatechange = function (state) {
          that.state = state;
          if (that.onstatechange) {
            that.onstatechange();
          }
        };
        if (that.state === 'connected') {
          if (that.onstatechange) {
            that.onstatechange();
          }
        }
      }, function () {
        log('warn', 'could not create presentation session');
        that.state = 'disconnected';
        if (that.onstatechange) {
          that.onstatechange();
        }
      });
  };


  /**
   * Sends a message to the wrapped cast or window presentation session
   *
   * @function
   * @param {*} message
   */
  PresentationSession.prototype.postMessage = function (message) {
    if (!this.session) {
      log('Presentation session not available, cannot send message');
      return;
    }
    if (this.state === 'disconnected') {
      log('Presentation session is disconnected, cannot send message');
      return;
    }
    this.session.postMessage(message);
  };


  /**
   * Close the session
   */
  PresentationSession.prototype.close = function () {
    if (!this.session) {
      return;
    }
    this.session.close();
    this.session = null;
  };


  /**
   * Implements the Presentation API
   *
   * TODO: the "onavailablechange" event is not yet implemented, mostly because
   * it should depend on the URL of the application that will be presented.
   */
  var Presentation = function () {
    this.onavailablechange = null;
    this.onpresent = null;

    var that = this;

    // Initializes presentation receiver bindings, dispatching the appropriate
    // "present" event if needed and a final "presentationready" message to the
    // sender (only useful for window presentations, Google Cast devices
    // apparently only report that the connection is ready when all this code
    // has run.
    // 3 cases arise:
    // 1. shim is running on a Google Cast device, and so running in a Google
    // Cast receiver application. The event is fired.
    // 2. shim is running in a window opened by some other window in response
    // to a call to navigator.presentation.requestSession. The event is fired.
    // 3. shim in running in regular Web app. No event fired.
    log('info', 'check whether code is running in a presentation receiver app');
    CastPresentationSession.startReceiver()
      .then(function (session) {
        return session;
      }, function () {
        return WindowPresentationSession.startReceiver();
      })
      .then(function (session) {
        log('info', 'yes, code is running in a presentation receiver app');
        if (that.onpresent) {
          log('dispatch "present" message');
          that.onpresent({
            session: session
          });
        }
        log('info', 'tell sender that presentation receiver app is ready');
        session.postMessage('presentationready');
      }, function () {
        log('info', 'no, code is not running in a presentation receiver app');
      });
  };


  /**
   * Requests display of web content on a connected screen
   *
   * @function
   * @param {String} url The URL to display on a connected screen
   */
  Presentation.prototype.requestSession = function (url) {
    return new PresentationSession(url);
  };


  /**
   * Non-standard function exposed so that this shim may know how to map
   * a URL to be presented to a Cast receiver application on a Chromecast
   * device
   *
   * @function
   * @param {String} url URL of the receiver application
   * @param {String} id The Cast application ID associated with that URL
   */
  Presentation.prototype.registerCastApplication = function (url, id) {
    CastPresentationSession.registerCastApplication(url, id);
  };


  // Expose the Presentation API to the navigator object
  // (the called should immediately bind to the "present" event to
  // detect execution in a receiver app)
  navigator.presentation = new Presentation();

}());
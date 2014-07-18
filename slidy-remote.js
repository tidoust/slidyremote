/**
 * @fileOverview The Slidy remote overwrites all commands of a locally running
 * instance of Slidy to have these commands sent to some presentation session,
 * effectively turning the Slidy library into a Slidy remote library (provided
 * the presentation session implements the slidy-receiver interface to pass
 * on the commands received to an underlying slide show).
 */
(function () {
  if (!window.w3c_slidy) {
    console.error('Slidy library must be loaded before the remote');
    return;
  }


  /**
   * Presentation session that the Slidy remote is to control
   * (set with a call to "bindToPresentationSession")
   *
   * @type {PresentationSession}
   */
  var presentationSession = null;


  /**
   * Whether a slideshow has been loaded or not
   */
  var slideshowLoaded = false;


  /**
   * Binds Slidy commands to the given PresentationSession
   *
   * All Slidy commands will be sent to that session from now on, if possible
   * (meaning if the session is not "disconnected").
   *
   * The presentation session should run slidy receiver code to be able to pass
   * the commands it receives to its underlying slide show.
   *
   * @function
   * @param {PresentationSession} session The presentation session to control
   */
  window.w3c_slidy.bindToPresentationSession = function (session) {
    presentationSession = session;

    this.add_listener(document, 'keydown', this.key_down);
    this.add_listener(document, 'keypress', this.key_press);
    this.add_listener(document, 'gesturechange', function ()
    {
      return false;
    });
    this.add_listener(document, 'touchstart', this.touchstart);
    this.add_listener(document, 'touchmove', this.touchmove);
    this.add_listener(document, 'touchend', this.touchend);
  };


  /**
   * Closes current Slidy remote (remove event listeners)
   *
   * @function
   */
  window.w3c_slidy.closePresentation = function () {
    document.removeEventListener('keydown', this.key_down);
    document.removeEventListener('keypress', this.key_press);
    document.removeEventListener('gesturechange');
    document.removeEventListener('touchstart', this.touchstart);
    document.removeEventListener('touchmove', this.touchmove);
    document.removeEventListener('touchend', this.touchend);
  };


  /**
   * Loads the slideshow at the given URL
   *
   * @function
   * @param {String} url URL of the slide show to load onto the presentation
   *  session
   */
  window.w3c_slidy.loadSlideshow = function (url) {
    slideshowLoaded = false;
    if (presentationSession && (presentationSession.state === 'connected')) {
      presentationSession.postMessage({
        cmd: 'open',
        url: url
      });
      slideshowLoaded = true;
    }
    else {
      console.warn('No presentation session to control, ' +
        'cannot load slideshow at "' + url + '"');
    }
  };


  /**
   * Prepare a function that turns a regular Slidy command into a command sent
   * to the presentation session controlled by this Slidy remote, if possible
   *
   * @function
   * @param {String} cmd The Slidy command to convert
   * @return {function} The Slidy function that should replace the default one.
   *   When called, that function sends the appropriate command to the
   *   underlying presentation session
   */
  var toPresentationCommand = function (cmd) {
    return function () {
      var message = {
        cmd: cmd
      };
      if (arguments.length > 0) {
        message.params = Array.prototype.slice.call(arguments);
      }
      if (presentationSession &&
          (presentationSession.state === 'connected') &&
          slideshowLoaded) {
        presentationSession.postMessage(message);
      }
      else {
        console.warn('No presentation session to control, ' +
          'cannot send Slidy command "' + cmd + '"');
      }
    };
  };


  // Overwrite commands of local Slidy instance to hit the presentation session.
  [
    'hide_table_of_contents',
    'next_slide',
    'previous_slide',
    'first_slide',
    'last_slide',
    'fold',
    'unfold',
    'smaller',
    'bigger',
    'toggle_toolbar',
    'toggle_view',
    'toggle_table_of_contents'
  ].forEach(function (cmd) {
    window.w3c_slidy[cmd] = toPresentationCommand(cmd);
  });

  window.w3c_slidy.initialized = true;
  window.w3c_slidy.hide_slides = function () {
    return;
  };

  window.w3c_slidy.toc = true;
  window.w3c_slidy.is_shown_toc = function () {
    return false;
  };

  window.w3c_slidy.init = function () {
  };
})();
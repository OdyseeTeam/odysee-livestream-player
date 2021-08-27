import firebase from 'firebase/app'
import jwt_decode from 'jwt-decode';

import 'firebase/auth'
import 'firebase/firestore'
import 'firebase/analytics'
import 'firebase/performance'
import 'firebase/messaging'
/**
 * Manage firebase authentication
 */
import {VStore} from '@/store';
import {logger} from "~/plugins/store-utils";

const firebaseConfig = {
  apiKey: "AIzaSyAU3pNgsB3oTMQ9gKIeRv8NNMoBC26ekZM",
  authDomain: "odysee-livestream-prod.firebaseapp.com",
  projectId: "odysee-livestream-prod",
  storageBucket: "odysee-livestream-prod.appspot.com",
  messagingSenderId: "1017399645596",
  appId: "1:1017399645596:web:79fa10b1abd66c46e5e459",
  measurementId: "G-26NXL3H4P2"

  //databaseURL: "https://bitwave-7f415.firebaseio.com", // don't need this for firestore db
};

if ( !firebase.apps.length ) {
  firebase.initializeApp( firebaseConfig );
}

const auth = firebase.auth();
const db = firebase.firestore();
const FieldValue = firebase.firestore.FieldValue;
const EmailAuthProvider = firebase.auth.EmailAuthProvider;

export { auth, db, FieldValue, EmailAuthProvider }


const listenToAuthState = ( callback ) => {
  console.log( `Starting auth state listener.` );
  return auth.onAuthStateChanged( async user => {
    const runParallel = [];
    // Handle login
    if ( user ) {
      if ( process.env.APP_DEBUG ) console.log( '[Firebase] Authenticated', user );
      runParallel.push( callback( user ) );
    } else {
      if ( process.env.APP_DEBUG ) console.log( '[Firebase] Not Authenticated' );
      runParallel.push( callback( null ) );
    }
    await Promise.all( runParallel );
  }, async error => {
    console.error( 'Auth Error:', error );
    this.$sentry.captureException( error );
  });
};

// Forces grabbing a refreshed token
const getFreshIdToken = async () => await auth.currentUser.getIdToken( true );


export const listenToConfiguationUpdates = callbacks => {
  return db
    .collection( 'configurations' )
    .doc( 'bitwave.tv' )
    .onSnapshot( async doc => {
      if ( !doc.exists ) {
        console.error( `No configuration, are we offline?` );
        return;
      }
      const data = doc.data();
      await Promise.all( callbacks.map( async cb => await cb( data ) ) );
    }, error => {
      console.error( 'DB Configuration Query Failed:', error );
      this.$sentry.captureException( error );
    });
};


export const listenToFeatureFlags = callbacks => {
  return db
    .collection( 'configurations' )
    .doc( 'features' )
    .onSnapshot( async doc => {
      if ( !doc.exists ) {
        console.error( `No feature flags, are we offline?` );
        return;
      }
      const data = doc.data();
      await Promise.all( callbacks.map( async cb => await cb( data ) ) );
    }, error => {
      console.error( 'Feature Flags Query Failed:', error );
      this.$sentry.captureException( error );
    });
};


export default async ( { app, store, $axios, $sentry }, inject ) => {
  // only run client side
  if ( process.client ) {
    if ( process.env.APP_DEBUG ) console.log( '[Firebase] Plugin ran (client only)', app );

    // Listen for authentication changes
    listenToAuthState( async user => {
      if ( user ) await store.dispatch( VStore.$actions.login, user );
      else await store.dispatch( VStore.$actions.logout );
    });

    // Listen to the configuration, and dispatch updates
    console.log( `Listening to configuration updates.` );
    listenToConfiguationUpdates([
      async ({ version }) => await store.dispatch( VStore.$actions.newVersionAvailable, version ),
      async ({ alerts }) => await store.dispatch( VStore.$actions.updateAlerts, alerts ),
    ]);

    // Listen to the feature flags, and dispatch updates
    /*console.log( `Listening to feature flags...` );
    listenToFeatureFlags([
      async ( featureFlags ) => await store.dispatch( VStore.$actions.updateFeatureFlags, featureFlags ),
    ]);*/



    // Begin performance mon
    console.log( `Starting performance module.` );
    const defaultPerformance = firebase.performance();
    inject( 'perf', defaultPerformance );

    // Inject analytics into context
    console.log( `Starting and injecting analytics module.` );
    if ( await firebase.analytics.isSupported() ) {
      const analytics = firebase.analytics();
      inject( 'analytics', analytics );
    } else {
      console.warn( `Analytics is not supported` );
    }

    if ( process.env.APP_DEBUG ) {
      console.log( `[DEV ENV ONLY] Injecting auth module.` );
      inject( 'auth', auth );
    }


    const getIdToken = async () => {
      if ( process.server ) {
        // When processing server-side, getIdToken() will only get called
        //  during SSR, from components. This means nuxtServerInit() will have already
        //  been called, and the auth token will have had(?) been saved.
        //
        // It is assumed that the token won't expire during SSR. I mean, what are the odds!
        return store.state [ VStore.$states.auth ];
      }

      if ( process.client ) {
        // This should work fine

        // If within 5 mins before expiration, force a token refresh
        // Otherwise, return what you already got (idToken)
        const processToken = async ( token ) => {
          try {
            if ( jwt_decode( token ).exp - Date.now() / 1000 <= ( 5 * 60 ) ) {
              console.log( `ID Token expired, requesting new token.` );
              return await getFreshIdToken();
            } else {
              return token;
            }
          }
          catch ( error ) {
            console.error( `Error checking token expiration`, token );
            $sentry.captureException( error );
            return null;
          }
        }

        try {
          // Attempt to get current logged in user
          const currentUser = auth.currentUser;

          // We are logged in, so just get the token directly
          if ( currentUser ) {
            const idToken = await currentUser.getIdToken();
            return await processToken( idToken );
          }

          // We are not logged in
          // Either user is actually not logged in
          // or auth has not finished initializing
          // and we need to wait for auth state to change
          if ( !currentUser ) {
            // if not logged in, add an auth state listener to wait for a possible login
            const waitForAuth = () => {
              return new Promise ( async ( resolve ) => {
                  const unsubscribe = listenToAuthState ( async ( user ) => {
                    unsubscribe(); // immediately stop listening to auth state
                    if ( user ) { // are we logged in now?
                      return resolve( await processToken( await user.getIdToken() ) );
                    } else { // nope, still not logged in
                      return resolve( null );
                    }
                  });
                }
              )
            };
            return await waitForAuth();
          }
        }
        catch ( error ) {
          console.warn( `Error getting ID Token!`, error );
          $sentry.captureException( error );
          return null;
        }
      }
    };


    // Intercepts all axios requests and injects Bearer token
    //  into the Authorization header. Equivalent to setToken(), except
    //  it gets called implicitly on each request.
    $axios.onRequest(
      async ( config ) => {

        const addBearerToken = async ( config ) => {
          if ( config.skipAuth ) return config;
          const token = await getIdToken();
          if ( config.headers != null && config.headers['X-Requested-With'] == null ) {
            if ( token ) {
              config.headers['Authorization'] = 'Bearer ' + token;
            }
          }
          return config;
        }

        return await addBearerToken( config );
      });


    // Add push notifications
    if ( !firebase.messaging.isSupported() ) {
      console.error( `FCM not supported` );
      return;
    }

    const messaging = firebase.messaging();
    messaging.usePublicVapidKey( 'BMghbCgNLfIbIqsuJaz4HV8EHYgu71MnONedQM26co3WfF2w0ahxzS6eq56JzPhaKVRamh_NtbbM-FdQsB-qXew' );
    inject( 'messaging', messaging );


    // Callback fired if Instance ID token is updated.
    messaging.onTokenRefresh(async () => {
      try {
        const refreshedToken = await messaging.getToken();

        console.log( 'Token refreshed.', refreshedToken );

        // Indicate that the new Instance ID token has not yet been sent to the app server.
        // setTokenSentToServer( false );

        // Send Instance ID token to app server.
        // sendTokenToServer( refreshedToken );
        // ...
      } catch ( err ) {
        console.log( 'Unable to retrieve refreshed token ', err );
        // showToken( 'Unable to retrieve refreshed token ', err );
      }
    });

    // Handle incoming messages. Called when:
    // - a message is received while the app has focus
    // - the user clicks on an app notification created by a service worker
    //   `messaging.setBackgroundMessageHandler` handler.
    messaging.onMessage(( payload ) => {
      console.log( 'Message received. ', payload );
    });



    // Persistence Manager
    /*try {
      await db.enablePersistence();
    } catch ( err ) {
      if ( err.code === 'failed-precondition' ) {
        console.log( `Multiple tabs open, persistence can only be enabled in one tab at a a time.` );
      } else if ( err.code === 'unimplemented' ) {
        console.log( `The current browser does not support all of the features required to enable persistence.` )
      }
    }*/
  }
}

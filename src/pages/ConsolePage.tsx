/**
 * Running a local relay server will allow you to hide your API key
 * and run custom logic on the server
 *
 * Set the local relay server address to:
 * REACT_APP_LOCAL_RELAY_SERVER_URL=http://localhost:8081
 *
 * This will also require you to set OPENAI_API_KEY= in a `.env` file
 * You can run it with `npm run relay`, in parallel with `npm start`
 */
const LOCAL_RELAY_SERVER_URL: string =
  process.env.REACT_APP_LOCAL_RELAY_SERVER_URL || '';

import { useEffect, useRef, useCallback, useState } from 'react';

import { RealtimeClient } from '@openai/realtime-api-beta';
import { ItemType } from '@openai/realtime-api-beta/dist/lib/client.js';
import { WavRecorder, WavStreamPlayer } from '../lib/wavtools/index.js';
import { instructions } from '../utils/conversation_config.js';
import { WavRenderer } from '../utils/wav_renderer';

import { X, Edit, Zap, ArrowUp, ArrowDown } from 'react-feather';
import { Button } from '../components/button/Button';
import { Toggle } from '../components/toggle/Toggle';
import { Map } from '../components/Map';

import './ConsolePage.scss';
import { isJsxOpeningLikeElement } from 'typescript';
import axios from 'axios';

/**
 * Type for result from get_weather() function call
 */
interface Coordinates {
  lat: number;
  lng: number;
  location?: string;
  temperature?: {
    value: number;
    units: string;
  };
  wind_speed?: {
    value: number;
    units: string;
  };
}

interface AvailableDate {
  id: number;
  available_date: string;
  available_timeslots: string;
  no_of_slots: number;
  createdAt: string;
  updatedAt: string;
}

interface FetchAvailableTimeSlotsParams {
  date: string; // Should be in 'YYYY-MM-DD' format
}

interface AvailableTimeSlotsResponse {
  date: string;
  availableTimeSlots: string[];
}

/**
 * Type for all event logs
 */
interface RealtimeEvent {
  time: string;
  source: 'client' | 'server';
  count?: number;
  event: { [key: string]: any };
}

export function ConsolePage() {
  /**
   * Ask user for API Key
   * If we're using the local relay server, we don't need this
   */
  const apiKey = LOCAL_RELAY_SERVER_URL
    ? ''
    : localStorage.getItem('tmp::voice_api_key') ||
      prompt('OpenAI API Key') ||
      '';
  if (apiKey !== '') {
    localStorage.setItem('tmp::voice_api_key', apiKey);
  }

  /**
   * Instantiate:
   * - WavRecorder (speech input)
   * - WavStreamPlayer (speech output)
   * - RealtimeClient (API client)
   */
  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({ sampleRate: 24000 })
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({ sampleRate: 24000 })
  );
  const clientRef = useRef<RealtimeClient>(
    new RealtimeClient(
      LOCAL_RELAY_SERVER_URL
        ? { url: LOCAL_RELAY_SERVER_URL }
        : {
            apiKey: apiKey,
            dangerouslyAllowAPIKeyInBrowser: true,
          }
    )
  );

  /**
   * References for
   * - Rendering audio visualization (canvas)
   * - Autoscrolling event logs
   * - Timing delta for event log displays
   */
  const [availableDates, setAvailableDates] = useState<AvailableDate[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const clientCanvasRef = useRef<HTMLCanvasElement>(null);
  const serverCanvasRef = useRef<HTMLCanvasElement>(null);
  const eventsScrollHeightRef = useRef(0);
  const eventsScrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<string>(new Date().toISOString());

  /**
   * All of our variables for displaying application state
   * - items are all conversation items (dialog)
   * - realtimeEvents are event logs, which can be expanded
   * - memoryKv is for set_memory() function
   * - coords, marker are for get_weather() function
   */
  const [items, setItems] = useState<ItemType[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeEvent[]>([]);
  const [expandedEvents, setExpandedEvents] = useState<{
    [key: string]: boolean;
  }>({});
  const [isConnected, setIsConnected] = useState(false);
  const [canPushToTalk, setCanPushToTalk] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [memoryKv, setMemoryKv] = useState<{ [key: string]: any }>({});
  const [extractedInfo, setExtractedInfo] = useState({});
  const [coords, setCoords] = useState<Coordinates | null>({
    lat: 37.775593,
    lng: -122.418137,
  });
  const [marker, setMarker] = useState<Coordinates | null>(null);

  /**
   * Utility for formatting the timing of logs
   */
  const formatTime = useCallback((timestamp: string) => {
    const startTime = startTimeRef.current;
    const t0 = new Date(startTime).valueOf();
    const t1 = new Date(timestamp).valueOf();
    const delta = t1 - t0;
    const hs = Math.floor(delta / 10) % 100;
    const s = Math.floor(delta / 1000) % 60;
    const m = Math.floor(delta / 60_000) % 60;
    const pad = (n: number) => {
      let s = n + '';
      while (s.length < 2) {
        s = '0' + s;
      }
      return s;
    };
    return `${pad(m)}:${pad(s)}.${pad(hs)}`;
  }, []);

  /**
   * When you click the API key
   */
  const resetAPIKey = useCallback(() => {
    const apiKey = prompt('OpenAI API Key');
    if (apiKey !== null) {
      localStorage.clear();
      localStorage.setItem('tmp::voice_api_key', apiKey);
      window.location.reload();
    }
  }, []);

  /**
   * Connect to conversation:
   * WavRecorder taks speech input, WavStreamPlayer output, client is API client
   */
  const connectConversation = useCallback(async () => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    // Set state variables
    startTimeRef.current = new Date().toISOString();
    setIsConnected(true);
    setRealtimeEvents([]);
    setItems(client.conversation.getItems());

    // Connect to microphone
    await wavRecorder.begin();

    // Connect to audio output
    await wavStreamPlayer.connect();

    // Connect to realtime API
    await client.connect();
    client.sendUserMessageContent([
      {
        type: `input_text`,
        text: `Hello`,
        // text: `For testing purposes, I want you to list ten car brands. Number each item, e.g. "one (or whatever number you are one): the item name".`
      },
    ]);

    if (client.getTurnDetectionType() === 'server_vad') {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
  }, []);

  /**
   * Disconnect and reset conversation state
   */
  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setRealtimeEvents([]);
    setItems([]);
    setMemoryKv({});
    setExtractedInfo({});
    setCoords({
      lat: 37.775593,
      lng: -122.418137,
    });
    setMarker(null);

    const client = clientRef.current;
    client.disconnect();

    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.end();

    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();
  }, []);

  const deleteConversationItem = useCallback(async (id: string) => {
    const client = clientRef.current;
    client.deleteItem(id);
  }, []);

  /**
   * In push-to-talk mode, start recording
   * .appendInputAudio() for each sample
   */
  const startRecording = async () => {
    setIsRecording(true);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const trackSampleOffset = await wavStreamPlayer.interrupt();
    if (trackSampleOffset?.trackId) {
      const { trackId, offset } = trackSampleOffset;
      await client.cancelResponse(trackId, offset);
    }
    await wavRecorder.record((data) => client.appendInputAudio(data.mono));
  };

  /**
   * In push-to-talk mode, stop recording
   */
  const stopRecording = async () => {
    setIsRecording(false);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.pause();
    client.createResponse();
  };

  /**
   * Switch between Manual <> VAD mode for communication
   */
  const changeTurnEndType = async (value: string) => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    if (value === 'none' && wavRecorder.getStatus() === 'recording') {
      await wavRecorder.pause();
    }
    client.updateSession({
      turn_detection: value === 'none' ? null : { type: 'server_vad' },
    });
    if (value === 'server_vad' && client.isConnected()) {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
    setCanPushToTalk(value === 'none');
  };

  /**
   * Auto-scroll the event logs
   */
  useEffect(() => {
    if (eventsScrollRef.current) {
      const eventsEl = eventsScrollRef.current;
      const scrollHeight = eventsEl.scrollHeight;
      // Only scroll if height has just changed
      if (scrollHeight !== eventsScrollHeightRef.current) {
        eventsEl.scrollTop = scrollHeight;
        eventsScrollHeightRef.current = scrollHeight;
      }
    }
  }, [realtimeEvents]);

  /**
   * Auto-scroll the conversation logs
   */
  useEffect(() => {
    const conversationEls = [].slice.call(
      document.body.querySelectorAll('[data-conversation-content]')
    );
    for (const el of conversationEls) {
      const conversationEl = el as HTMLDivElement;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }
  }, [items]);

  /**
   * Set up render loops for the visualization canvas
   */
  useEffect(() => {
    let isLoaded = true;

    const wavRecorder = wavRecorderRef.current;
    const clientCanvas = clientCanvasRef.current;
    let clientCtx: CanvasRenderingContext2D | null = null;

    const wavStreamPlayer = wavStreamPlayerRef.current;
    const serverCanvas = serverCanvasRef.current;
    let serverCtx: CanvasRenderingContext2D | null = null;

    const render = () => {
      if (isLoaded) {
        if (clientCanvas) {
          if (!clientCanvas.width || !clientCanvas.height) {
            clientCanvas.width = clientCanvas.offsetWidth;
            clientCanvas.height = clientCanvas.offsetHeight;
          }
          clientCtx = clientCtx || clientCanvas.getContext('2d');
          if (clientCtx) {
            clientCtx.clearRect(0, 0, clientCanvas.width, clientCanvas.height);
            const result = wavRecorder.recording
              ? wavRecorder.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              clientCanvas,
              clientCtx,
              result.values,
              '#0099ff',
              10,
              0,
              8
            );
          }
        }
        if (serverCanvas) {
          if (!serverCanvas.width || !serverCanvas.height) {
            serverCanvas.width = serverCanvas.offsetWidth;
            serverCanvas.height = serverCanvas.offsetHeight;
          }
          serverCtx = serverCtx || serverCanvas.getContext('2d');
          if (serverCtx) {
            serverCtx.clearRect(0, 0, serverCanvas.width, serverCanvas.height);
            const result = wavStreamPlayer.analyser
              ? wavStreamPlayer.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              serverCanvas,
              serverCtx,
              result.values,
              '#009900',
              10,
              0,
              8
            );
          }
        }
        window.requestAnimationFrame(render);
      }
    };
    render();

    return () => {
      isLoaded = false;
    };
  }, []);

  /**
   * Core RealtimeClient and audio capture setup
   * Set all of our instructions, tools, events and more
   */
  useEffect(() => {
    // Get refs
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const client = clientRef.current;

    // Set instructions
    client.updateSession({ instructions: instructions });
    // Set transcription, otherwise we don't get user transcriptions back
    client.updateSession({ input_audio_transcription: { model: 'whisper-1' } });

    // Add tools
    // client.addTool(
    //   {
    //     name: 'set_memory',
    //     description: 'Saves important data about the user into memory.',
    //     parameters: {
    //       type: 'object',
    //       properties: {
    //         key: {
    //           type: 'string',
    //           description:
    //             'The key of the memory value. Always use lowercase and underscores, no other characters.',
    //         },
    //         value: {
    //           type: 'string',
    //           description: 'Value can be anything represented as a string',
    //         },
    //       },
    //       required: ['key', 'value'],
    //     },
    //   },
    //   async ({ key, value }: { [key: string]: any }) => {
    //     setMemoryKv((memoryKv) => {
    //       const newKv = { ...memoryKv };
    //       newKv[key] = value;
    //       return newKv;
    //     });
    //     return { ok: true };
    //   }
    // );

    // async function getAvailableTimeSlots() {
    //   try {
    //     // Call the API to fetch the available time slots for the date
    //     // const response = await axios.get(
    //     //   'http://localhost:3000/getAvailableTimeSlots',
    //     //   {
    //     //     params: { date },
    //     //   }
    //     // );
    //     const date = '2024-10-17';
    //     const availableSlots = {
    //       '2024-10-17': ['09:00', '10:00', '14:00', '15:00'],
    //       '2024-10-18': ['11:00', '13:00'],
    //     };

    //     // if (!availableSlots || availableSlots.length === 0) {
    //     //   return `No available time slots for ${date}.`;
    //     // }
    //     const slots = availableSlots[date] || [];
    //     return `Available time slots for ${date}: ${slots.join(', ')}`;
    //   } catch (error) {
    //     return `Error fetching time slots:`;
    //   }
    // }

    // client.addTool(
    //   {
    //     name: 'fetch_available_dates',
    //     description:
    //       'Fetches available dates of blood test booking and returns them to the user.',
    //     parameters: {},
    //   },
    //   async () => {
    //     try {
    //       // Mock data representing available dates
    //       const mockDates = ['2024-10-20', '2024-10-21', '2024-10-22'];

    //       // Return the available dates with their corresponding time slots
    //       return {
    //         availableDatesAndSlots: mockDates,
    //       };
    //     } catch (error) {
    //       console.error('Error fetching available dates and slots:', error);
    //       throw new Error('Unable to fetch available dates and timeslots');
    //     }
    //   }
    // );

    // client.addTool(
    //   {
    //     name: 'fetch_available_dates',
    //     description:
    //       'Fetches available dates of blood test booking and returns them to the user.',
    //     parameters: {},
    //   },
    //   async () => {
    //     try {
    //       const delay = (ms: any) =>
    //         new Promise((resolve) => setTimeout(resolve, ms));

    //       // Wait for the delay before returning the mock data
    //       await delay(3000); // Simulating a 3-second delay

    //       // Mock data representing available dates
    //       const mockDates = ['2024-10-23', '2024-10-24', '2024-10-25'];

    //       // Return the available dates with their corresponding time slots
    //       return {
    //         availableDatesAndSlots: mockDates,
    //       };
    //     } catch (error) {
    //       console.error('Error fetching available dates and slots:', error);
    //       throw new Error('Unable to fetch available dates and timeslots');
    //     }
    //   }
    // );

    client.addTool(
      {
        name: 'fetch_available_dates',
        description:
          'Fetches available dates of blood test booking and returns them to the user.',
        parameters: {},
      },
      async () => {
        try {
          // Fetching the available dates from the API
          const response = await axios.get<AvailableDate[]>('');

          return {};
        } catch (error) {
          console.error('Error fetching available dates and slots:', error);
          throw new Error('Unable to fetch available dates and timeslots');
        }
      }
    );

    client.addTool(
      {
        name: 'fetch_available_timeslots',
        description:
          'Fetches available time slots for a specified date for blood test booking and returns them to the user.',
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              format: 'date',
              description:
                'The date for which to fetch available time slots (YYYY-MM-DD).',
            },
          },
          required: ['date'],
        },
      },
      async ({ date }: any) => {
        try {
          // Fetch the available timeslots by making an API call to your backend
          const response = await fetch(
            `http://localhost:3000/api/availability/timeslots?available_date=${date}`,
            {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json',
              },
            }
          );

          if (!response.ok) {
            throw new Error('Failed to fetch available time slots');
          }

          const data = await response.json();
          return data.available_timeslots; // Return the available timeslots to the user
        } catch (error) {
          console.error('Error fetching available time slots:', error);
          throw new Error(
            'Unable to fetch available time slots for the specified date'
          );
        }
      }
    );

    client.addTool(
      {
        name: 'extract_user_data',
        description:
          'Extract user data for blood test booking, including username, booking date, timeslot, additional notes, and transcriptions of the conversation.',
        parameters: {
          type: 'object',
          properties: {
            username: {
              type: 'string',
              description: "The user's full name",
            },
            booking_date: {
              type: 'string',
              description:
                'Preferred date for the blood test (format: YYYY-MM-DD)',
            },
            booking_timeslot: {
              type: 'string',
              description:
                'Preferred timeslot for the blood test (format: HH:MM)',
            },
            additional_notes: {
              type: 'string',
              description:
                'Any additional notes or instructions for the blood test',
            },
            user_transcription: {
              type: 'string',
              description: 'Complete transcription of the user’s inputs',
            },
            assistant_transcription: {
              type: 'string',
              description: 'Complete transcription of the assistant’s outputs',
            },
          },
          required: [
            'username',
            'booking_date',
            'booking_timeslot',
            'user_transcription',
            'assistant_transcription',
          ],
        },
      },
      async ({
        username,
        booking_date,
        booking_timeslot,
        additional_notes,
        user_transcription,
        assistant_transcription,
      }: {
        [key: string]: any;
      }) => {
        const userData = {
          username: username,
          booking_date: booking_date,
          booking_timeslot: booking_timeslot,
          additional_notes: additional_notes || '',
          user_transcription: user_transcription,
          assistant_transcription: assistant_transcription,
        };

        try {
          const response = await axios.post(
            'http://localhost:3000/api/bookings',
            userData
          );
          console.log('Data saved successfully:', response.data);

          // Return success response
          return { ok: true };
        } catch (error) {
          console.error('Error saving data:', error);

          // Return error response
          return {
            ok: false,
            message:
              'There was a problem processing your booking. Please try again.',
          };
        }
        // try {
        //   const response = await axios.post(
        //     'http://localhost:3000/api/bookings',
        //     userData
        //   );
        //   console.log('Data saved successfully:', response.data);
        // } catch (error) {
        //   console.error('Error saving data:', error);
        // }

        // setExtractedInfo(userData);

        // return { ok: true };
      }
    );

    client.addTool(
      {
        name: 'get_weather',
        description:
          'Retrieves the weather for a given lat, lng coordinate pair. Specify a label for the location.',
        parameters: {
          type: 'object',
          properties: {
            lat: {
              type: 'number',
              description: 'Latitude',
            },
            lng: {
              type: 'number',
              description: 'Longitude',
            },
            location: {
              type: 'string',
              description: 'Name of the location',
            },
          },
          required: ['lat', 'lng', 'location'],
        },
      },
      async ({ lat, lng, location }: { [key: string]: any }) => {
        setMarker({ lat, lng, location });
        setCoords({ lat, lng, location });
        const result = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m`
        );
        const json = await result.json();
        const temperature = {
          value: json.current.temperature_2m as number,
          units: json.current_units.temperature_2m as string,
        };
        const wind_speed = {
          value: json.current.wind_speed_10m as number,
          units: json.current_units.wind_speed_10m as string,
        };
        setMarker({ lat, lng, location, temperature, wind_speed });
        return json;
      }
    );

    // handle realtime events from client + server for event logging
    client.on('realtime.event', (realtimeEvent: RealtimeEvent) => {
      setRealtimeEvents((realtimeEvents) => {
        const lastEvent = realtimeEvents[realtimeEvents.length - 1];
        if (lastEvent?.event.type === realtimeEvent.event.type) {
          // if we receive multiple events in a row, aggregate them for display purposes
          lastEvent.count = (lastEvent.count || 0) + 1;
          return realtimeEvents.slice(0, -1).concat(lastEvent);
        } else {
          return realtimeEvents.concat(realtimeEvent);
        }
      });
    });
    client.on('error', (event: any) => console.error(event));
    client.on('conversation.interrupted', async () => {
      const trackSampleOffset = await wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        const { trackId, offset } = trackSampleOffset;
        await client.cancelResponse(trackId, offset);
      }
    });
    client.on('conversation.updated', async ({ item, delta }: any) => {
      const items = client.conversation.getItems();
      if (delta?.audio) {
        wavStreamPlayer.add16BitPCM(delta.audio, item.id);
      }
      if (item.status === 'completed' && item.formatted.audio?.length) {
        const wavFile = await WavRecorder.decode(
          item.formatted.audio,
          24000,
          24000
        );
        item.formatted.file = wavFile;
      }
      setItems(items);
    });

    setItems(client.conversation.getItems());

    return () => {
      // cleanup; resets to defaults
      client.reset();
    };
  }, []);

  /**
   * Render the application
   */
  return (
    <div data-component="ConsolePage">
      <div className="content-top">
        <div className="content-title">
          <img src="/openai-logomark.svg" />
          <span>Voice-Based Appointment Scheduler</span>
        </div>
        <div className="content-api-key">
          {!LOCAL_RELAY_SERVER_URL && (
            <Button
              icon={Edit}
              iconPosition="end"
              buttonStyle="flush"
              label={`api key: ${apiKey.slice(0, 3)}...`}
              onClick={() => resetAPIKey()}
            />
          )}
        </div>
      </div>
      <div className="content-main">
        <div className="content-logs">
          <div className="content-block events">
            <div className="visualization">
              <div className="visualization-entry client">
                <canvas ref={clientCanvasRef} />
              </div>
              <div className="visualization-entry server">
                <canvas ref={serverCanvasRef} />
              </div>
            </div>
            <div className="content-block-title">events</div>
            <div className="content-block-body" ref={eventsScrollRef}>
              {!realtimeEvents.length && `awaiting connection...`}
              {realtimeEvents.map((realtimeEvent, i) => {
                const count = realtimeEvent.count;
                const event = { ...realtimeEvent.event };
                if (event.type === 'input_audio_buffer.append') {
                  event.audio = `[trimmed: ${event.audio.length} bytes]`;
                } else if (event.type === 'response.audio.delta') {
                  event.delta = `[trimmed: ${event.delta.length} bytes]`;
                }
                return (
                  <div className="event" key={event.event_id}>
                    <div className="event-timestamp">
                      {formatTime(realtimeEvent.time)}
                    </div>
                    <div className="event-details">
                      <div
                        className="event-summary"
                        onClick={() => {
                          // toggle event details
                          const id = event.event_id;
                          const expanded = { ...expandedEvents };
                          if (expanded[id]) {
                            delete expanded[id];
                          } else {
                            expanded[id] = true;
                          }
                          setExpandedEvents(expanded);
                        }}
                      >
                        <div
                          className={`event-source ${
                            event.type === 'error'
                              ? 'error'
                              : realtimeEvent.source
                          }`}
                        >
                          {realtimeEvent.source === 'client' ? (
                            <ArrowUp />
                          ) : (
                            <ArrowDown />
                          )}
                          <span>
                            {event.type === 'error'
                              ? 'error!'
                              : realtimeEvent.source}
                          </span>
                        </div>
                        <div className="event-type">
                          {event.type}
                          {count && ` (${count})`}
                        </div>
                      </div>
                      {!!expandedEvents[event.event_id] && (
                        <div className="event-payload">
                          {JSON.stringify(event, null, 2)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="content-block conversation">
              <div className="content-block-title">conversation</div>
              <div className="content-block-body" data-conversation-content>
                {!items.length && `awaiting connection...`}
                {items.map((conversationItem, i) => {
                  return (
                    <div
                      className="conversation-item"
                      key={conversationItem.id}
                    >
                      <div className={`speaker ${conversationItem.role || ''}`}>
                        <div>
                          {(
                            conversationItem.role || conversationItem.type
                          ).replaceAll('_', ' ')}
                        </div>
                        <div
                          className="close"
                          onClick={() =>
                            deleteConversationItem(conversationItem.id)
                          }
                        >
                          <X />
                        </div>
                      </div>
                      <div className={`speaker-content`}>
                        {/* tool response */}
                        {conversationItem.type === 'function_call_output' && (
                          <div>{conversationItem.formatted.output}</div>
                        )}
                        {/* tool call */}
                        {!!conversationItem.formatted.tool && (
                          <div>
                            {conversationItem.formatted.tool.name}(
                            {conversationItem.formatted.tool.arguments})
                          </div>
                        )}
                        {!conversationItem.formatted.tool &&
                          conversationItem.role === 'user' && (
                            <div>
                              {conversationItem.formatted.transcript ||
                                (conversationItem.formatted.audio?.length
                                  ? '(awaiting transcript)'
                                  : conversationItem.formatted.text ||
                                    '(item sent)')}
                            </div>
                          )}
                        {!conversationItem.formatted.tool &&
                          conversationItem.role === 'assistant' && (
                            <div>
                              {conversationItem.formatted.transcript ||
                                conversationItem.formatted.text ||
                                '(truncated)'}
                            </div>
                          )}
                        {conversationItem.formatted.file && (
                          <audio
                            src={conversationItem.formatted.file.url}
                            controls
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="content-actions">
            <Toggle
              defaultValue={false}
              labels={['manual', 'vad']}
              values={['none', 'server_vad']}
              onChange={(_, value) => changeTurnEndType(value)}
            />
            <div className="spacer" />
            {isConnected && canPushToTalk && (
              <Button
                label={isRecording ? 'release to send' : 'push to talk'}
                buttonStyle={isRecording ? 'alert' : 'regular'}
                disabled={!isConnected || !canPushToTalk}
                onMouseDown={startRecording}
                onMouseUp={stopRecording}
              />
            )}
            <div className="spacer" />
            <Button
              label={isConnected ? 'disconnect' : 'connect'}
              iconPosition={isConnected ? 'end' : 'start'}
              icon={isConnected ? X : Zap}
              buttonStyle={isConnected ? 'regular' : 'action'}
              onClick={
                isConnected ? disconnectConversation : connectConversation
              }
            />
          </div>
        </div>
        <div className="content-right">
          <div className="content-block kv">
            <div className="content-block-title">Test booking info:</div>
            <div className="content-block-body content-kv">
              {JSON.stringify(extractedInfo, null, 2)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

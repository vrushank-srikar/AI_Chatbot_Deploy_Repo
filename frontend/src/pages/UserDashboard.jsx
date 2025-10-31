import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import ReactMarkdown from "react-markdown";
import { io } from "socket.io-client";
import "../styles/UserDashboard.css";

const API_BASE = "http://localhost:5000";

export default function UserDashboard() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [user, setUser] = useState(null);
  const [userCases, setUserCases] = useState([]);
  const [error, setError] = useState(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedDomain, setSelectedDomain] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isBotTyping, setIsBotTyping] = useState(false);
  const [isEndingChat, setIsEndingChat] = useState(false);

  const chatBoxRef = useRef(null);
  const inactivityTimeoutRef = useRef(null);
  const socketRef = useRef(null);

  // keep current selection inside listeners without re-subscribing
  const selectedRef = useRef(null);
  const seenEventsRef = useRef(new Set());

  const domains = [
    { name: "E-commerce", icon: "🛒", description: "Manage your online shopping orders and support cases." },
    { name: "Travel", icon: "✈️", description: "Track travel bookings and resolve travel-related issues." },
    { name: "Telecommunications", icon: "📱", description: "Handle mobile plans, billing, and service queries." },
    { name: "Banking Services", icon: "🏦", description: "Monitor accounts, transactions, and banking support." },
  ];

  /* ------------------------ helpers: inactivity timer ------------------------ */
  const clearInactivityTimeout = useCallback(() => {
    if (inactivityTimeoutRef.current) {
      clearTimeout(inactivityTimeoutRef.current);
      inactivityTimeoutRef.current = null;
    }
  }, []);

  const setInactivityTimeout = useCallback(() => {
    clearInactivityTimeout();
    inactivityTimeoutRef.current = setTimeout(() => {
      handleCloseChat();
    }, 15 * 60 * 1000); // 15 minutes
  }, [clearInactivityTimeout]);

  /* ------------------------------ data fetching ----------------------------- */
  const fetchUserCases = useCallback(async () => {
    if (!id || !selectedDomain) return;
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem("token");
      const res = await axios.get(
        `${API_BASE}/api/user/${id}/cases?domain=${selectedDomain}&_t=${Date.now()}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setUserCases(res.data.cases || []);
    } catch (err) {
      console.error("Failed to fetch user cases:", err);
      setError(err.response?.data?.error || "Failed to fetch cases.");
    } finally {
      setLoading(false);
    }
  }, [id, selectedDomain]);

  useEffect(() => {
    const fetchUser = async () => {
      setLoading(true);
      setError(null);
      try {
        const token = localStorage.getItem("token");
        if (!token) {
          setError("No authentication token found. Please log in.");
          navigate("/");
          return;
        }

        const source = axios.CancelToken.source();
        const timeout = setTimeout(() => source.cancel("Request timed out"), 10000);

        const res = await axios.get(`${API_BASE}/api/user/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
          cancelToken: source.token,
        });

        clearTimeout(timeout);
        if (res.data) setUser(res.data);
        else setError("No user data returned from the server.");
      } catch (err) {
        console.error("Failed to fetch user:", err);
        if (axios.isCancel(err)) {
          setError("Request to fetch user data timed out. Please try again.");
        } else {
          setError(err.response?.data?.error || "Failed to load user data.");
          if (err.response?.status === 401) {
            localStorage.removeItem("token");
            navigate("/");
          }
        }
      } finally {
        setLoading(false);
      }
    };
    fetchUser();
  }, [id, navigate]);

  useEffect(() => {
    if (selectedDomain) fetchUserCases();
  }, [selectedDomain, fetchUserCases]);

  // auto-scroll on new content
  useEffect(() => {
    if (chatBoxRef.current && isChatOpen) {
      chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
    }
  }, [messages, isChatOpen, isBotTyping]);

  useEffect(() => () => clearInactivityTimeout(), [clearInactivityTimeout]);

  // keep current product available to socket listeners
  useEffect(() => {
    selectedRef.current = selectedProduct;
  }, [selectedProduct]);

  /* ------------------------- thread loaders (unified) ------------------------ */
  const normalizeThreadToMessages = (thread = []) => {
    const out = [];
    thread.forEach((t) => {
      if (t.prompt) {
        out.push({
          text: t.prompt,
          sender: "user",
          senderName: user?.name || "User",
          timestamp: t.timestamp || new Date().toISOString(),
        });
      }
      if (t.message) {
        const sender = t.source === "agent" ? "agent" : "bot";
        const senderName = sender === "agent" ? "Support Agent" : "Support Bot";
        out.push({
          text: t.message,
          sender,
          senderName,
          timestamp: t.timestamp || new Date().toISOString(),
        });
      }
    });
    return out;
  };

  // Fallback for older backend: map /api/chat/history into message pairs
  const normalizeHistoryToMessages = (chats = []) => {
    const out = [];
    chats.forEach((c) => {
      if (c.prompt) {
        out.push({
          text: c.prompt,
          sender: "user",
          senderName: user?.name || "User",
          timestamp: c.timestamp || new Date().toISOString(),
        });
      }
      if (c.reply) {
        out.push({
          text: c.reply,
          sender: c.source === "case-memory" || c.source === "faq" || c.source === "llm" ? "bot" : "bot",
          senderName: "Support Bot",
          timestamp: c.timestamp || new Date().toISOString(),
        });
      }
    });
    return out;
  };

  const fetchUnifiedThread = async (orderId, productIndex) => {
    try {
      const token = localStorage.getItem("token");
      if (!token) return;
      // Preferred: unified thread API
      const res = await axios.get(`${API_BASE}/api/chat/thread`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { orderId, productIndex },
      });
      const normalized = normalizeThreadToMessages(res.data.thread || []);
      setMessages(normalized);
    } catch (err) {
      // graceful fallback to old history API
      try {
        const token = localStorage.getItem("token");
        const res = await axios.get(`${API_BASE}/api/chat/history`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { orderId, productIndex },
        });
        const normalized = normalizeHistoryToMessages(res.data.chats || []);
        setMessages(normalized);
      } catch (e2) {
        console.error("Failed to fetch chat thread:", e2);
      }
    }
  };

  /* ---------------------------- socket: connect once ---------------------------- */
  // tiny de-dup (covers strict-mode re-mount, reconnects, etc.)
  function shouldAcceptEvent(key) {
    const set = seenEventsRef.current;
    if (set.has(key)) return false;
    set.add(key);
    if (set.size > 200) {
      // keep it bounded
      const last = Array.from(set).slice(-150);
      seenEventsRef.current = new Set(last);
    }
    return true;
  }

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) return;

    if (socketRef.current?.connected) return; // already connected

    const socket = io(API_BASE, { auth: { token } });
    socketRef.current = socket;

    // bot or agent mirrored as chat
    socket.on("chat:reply", (payload) => {
      if (payload.source === "agent") return; 
      const sel = selectedRef.current;
      if (!sel) return;

      if (
        String(payload.orderId) !== String(sel.orderId) ||
        Number(payload.productIndex) !== Number(sel.productIndex)
      ) return;

       const key = payload.eventId || `reply|${payload.orderId}|${payload.productIndex}|${payload.source}|${payload.message}|${Math.floor((payload.timestamp || Date.now())/1000)}`;
  if (!shouldAcceptEvent(key)) return;
      const sender = payload.source === "agent" ? "agent" : "bot";
      const senderName = sender === "agent" ? "Support Agent" : "Support Bot";

      setMessages((prev) => [
        ...prev,
        {
          text: payload.message,
          sender,
          senderName,
          timestamp: payload.timestamp || new Date().toISOString(),
        },
      ]);

      if (chatBoxRef.current) {
        setTimeout(() => {
          chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
        }, 0);
      }
    });

    // raw case messages (admin panel)
    socket.on("case:message", (payload) => {
      // We can't verify order/product here unless server also emits them.
      // We still de-dup and show since it's for the same user.
      const key =
        (payload.eventId && `case|${payload.eventId}`) ||
        `case|${payload.caseId}|${payload.sender}|${payload.message}|${Math.floor((payload.timestamp || Date.now()) / 1000)}`;
      if (!shouldAcceptEvent(key)) return;

      const sender = payload.sender === "agent" ? "agent" : "system";
      const senderName = sender === "agent" ? "Support Agent" : "System";

      setMessages((prev) => [
        ...prev,
        {
          text: payload.message,
          sender,
          senderName,
          timestamp: payload.timestamp || new Date().toISOString(),
        },
      ]);

      if (chatBoxRef.current) {
        setTimeout(() => {
          chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
        }, 0);
      }
    });

    socket.on("case:status", () => {
      fetchUserCases();
    });

    return () => {
      try {
        socket.off("chat:reply");
        socket.off("case:message");
        socket.off("case:status");
        socket.disconnect();
      } catch {}
      socketRef.current = null;
      seenEventsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount once

  /* ------------------------------- UI handlers ------------------------------ */
  const handleDomainClick = (domain) => {
    clearInactivityTimeout();
    setSelectedDomain(domain.name);
    setSelectedProduct(null);
    setIsChatOpen(false);
    setMessages([]);
    setIsEndingChat(false);
  };

  const handleProductClick = async (product) => {
    setLoading(true);
    setError(null);
    setIsEndingChat(false);
    try {
      const token = localStorage.getItem("token");
      await axios.post(
        `${API_BASE}/api/select-product`,
        { orderId: product.orderId, productIndex: product.productIndex },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSelectedProduct(product);

      // load unified thread (bot + agent)
      await fetchUnifiedThread(product.orderId, product.productIndex);

      // open chat & start inactivity timer
      setIsChatOpen(true);
      setInactivityTimeout();
    } catch (err) {
      console.error("Failed to select product:", err);
      setError("Failed to select product for chat.");
    } finally {
      setLoading(false);
    }
  };

  // keep thread in sync if product changes elsewhere
  useEffect(() => {
    if (selectedProduct) {
      fetchUnifiedThread(selectedProduct.orderId, selectedProduct.productIndex);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProduct?.orderId, selectedProduct?.productIndex]);

  const handleSend = async () => {
    const messageToSend = input.trim();
    if (!messageToSend || !selectedProduct || isEndingChat) return;

    // show the user's message immediately
    const userMsg = {
      text: messageToSend,
      sender: "user",
      senderName: user?.name || "User",
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    setInactivityTimeout();
    setIsBotTyping(true);
    setError(null);

    try {
      const token = localStorage.getItem("token");
      if (!token) {
        setError("No authentication token found. Please log in.");
        navigate("/");
        setIsBotTyping(false);
        return;
      }

      // send to backend; DO NOT append bot reply here (socket will push it)
      await axios.post(
        `${API_BASE}/api/chat`,
        { message: messageToSend },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // refresh cases shortly after
      setTimeout(fetchUserCases, 800);
    } catch (err) {
      console.error("Chat error:", err);
      setError(err.response?.data?.error || "Failed to send message.");
    } finally {
      setIsBotTyping(false);
      setInput("");
    }
  };

  const handleCloseChat = async () => {
    if (isEndingChat) return;
    clearInactivityTimeout();
    setIsEndingChat(true);
    setMessages((prev) => [
      ...prev,
      {
        text: "The chat has been ended.",
        sender: "system",
        senderName: "System",
        timestamp: new Date().toISOString(),
      },
    ]);
    if (chatBoxRef.current) {
      chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
    }
  };

  const handleDirectClose = async () => {
    clearInactivityTimeout();
    setIsEndingChat(false);
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem("token");
      await axios.post(
        `${API_BASE}/api/clear-selected-product`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSelectedProduct(null);
      setMessages([]);
      setIsChatOpen(false);
    } catch (err) {
      console.error("Failed to clear selected product:", err);
      setError("Failed to clear selected product.");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    clearInactivityTimeout();
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem("token");
      if (token) {
        await axios.post(
          `${API_BASE}/api/logout`,
          {},
          { headers: { Authorization: `Bearer ${token}` } }
        );
      }
      localStorage.removeItem("token");
      navigate("/");
    } catch (err) {
      console.error("Logout error:", err);
      setError("Logout failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !isEndingChat) {
      e.preventDefault();
      handleSend();
    }
  };

  /* ---------------------------------- UI ---------------------------------- */
  if (error) {
    return (
      <div className="user-dashboard">
        <h2>Error</h2>
        <p className="error-message">{error}</p>
        <button onClick={() => navigate("/")} className="logout-btn">
          Back to Login
        </button>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="user-dashboard">
        <div className="loading">Loading user data...</div>
      </div>
    );
  }

  const allProducts = user.orders
    .flatMap((order) =>
      order.products.map((product, index) => ({
        ...product,
        orderId: order.orderId,
        orderDate: order.orderDate,
        status: order.status,
        productIndex: index,
      }))
    )
    .filter((product) => !selectedDomain || product.domain === selectedDomain);

  return (
    <div className="user-dashboard">
      <button onClick={handleLogout} className="logout-btn">
        Logout
      </button>
      <h2>Welcome, {user.name}</h2>

      <div className="domain-section">
        <h3>Your Domains</h3>
        <div className="domain-grid">
          {domains.map((domain, index) => (
            <div
              key={index}
              className={`domain-card ${selectedDomain === domain.name ? "selected" : ""}`}
              onClick={() => handleDomainClick(domain)}
            >
              <span className="domain-icon">{domain.icon}</span>
              <h4>{domain.name}</h4>
              <p>{domain.description}</p>
            </div>
          ))}
        </div>
      </div>

      {selectedDomain && (
        <>
          <div className="product-list">
            <h3>{selectedDomain} Products</h3>
            {loading && <div className="loading">Loading...</div>}
            {allProducts.length > 0 ? (
              <div className="product-grid">
                {allProducts.map((product, index) => {
                  const hasCase = userCases.some(
                    (c) => c.orderId === product.orderId && c.productIndex === product.productIndex
                  );
                  const isSelected =
                    selectedProduct &&
                    selectedProduct.orderId === product.orderId &&
                    selectedProduct.productIndex === product.productIndex;
                  return (
                    <div
                      key={index}
                      className={`product-card ${isSelected ? "selected" : ""}`}
                      onClick={() => handleProductClick(product)}
                    >
                      <h4>{product.name}</h4>
                      <p>Quantity: {product.quantity}</p>
                      <p>Price: ₹{product.price}</p>
                      <p>Order ID: {product.orderId}</p>
                      <p>Order Date: {new Date(product.orderDate).toLocaleDateString()}</p>
                      <p>Status: {product.status}</p>
                      {hasCase && <span className="ticket-badge">Ticket Created</span>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p>No products ordered in {selectedDomain} yet.</p>
            )}
          </div>

          <div className="cases-section">
            <h3>Your {selectedDomain} Cases</h3>
            {loading && <div className="loading">Loading...</div>}
            {userCases.length > 0 ? (
              <div className="cases-list">
                {userCases.map((caseItem) => (
                  <div key={caseItem._id} className="case-card">
                    <h4>Case ID: {caseItem._id}</h4>
                    <p><strong>Order ID:</strong> {caseItem.orderId}</p>
                    <p><strong>Product Index:</strong> {caseItem.productIndex}</p>
                    <p><strong>Description:</strong> {caseItem.description}</p>
                    <p><strong>Priority:</strong> {caseItem.priority}</p>
                    <p><strong>Status:</strong> {caseItem.status}</p>
                    <p><strong>Created:</strong> {new Date(caseItem.createdAt).toLocaleString()}</p>
                    <p><strong>Updated:</strong> {new Date(caseItem.updatedAt).toLocaleString()}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p>No cases found for {selectedDomain}.</p>
            )}
          </div>
        </>
      )}

      {isChatOpen && (
        <div className="chat-container">
          <div className="chat-header">
            <h3>{selectedProduct ? `Chat for ${selectedProduct.name}` : "Support Chat"}</h3>
            <div className="header-actions">
              <button className="end-chat-btn" onClick={handleCloseChat} disabled={isEndingChat}>
                {isEndingChat ? "Ended" : "End Chat"}
              </button>
              <button className="close-chat-btn" onClick={handleDirectClose}>
                &times;
              </button>
            </div>
          </div>

          <div className="chat-box" ref={chatBoxRef}>
            {messages.length === 0 ? (
              <h3><b>💬 Start a conversation with our AI Assistant 🤖 for instant support.</b></h3>
            ) : (
              messages.map((msg, index) => (
                <div
                  key={index}
                  className={
                    msg.sender === "user" ? "user-msg" :
                    msg.sender === "system" ? "system-msg" :
                    msg.sender === "agent" ? "agent-msg" : "bot-msg"
                  }
                >
                  <div className="sender-info">{msg.senderName}</div>
                  <div className="message-text">
                    <ReactMarkdown>{msg.text}</ReactMarkdown>
                  </div>
                  <div className="timestamp">
                    {new Date(msg.timestamp).toLocaleString()}
                  </div>
                </div>
              ))
            )}

            {isBotTyping && !isEndingChat && (
              <div className="bot-msg typing">
                <div className="sender-info">Support Bot</div>
                <div className="message-text">
                  <span className="typing-dots">
                    Typing<span className="dot">.</span>
                    <span className="dot">.</span>
                    <span className="dot">.</span>
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="chat-input">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Type your message..."
              disabled={loading || isBotTyping}
            />
            <button onClick={handleSend} disabled={loading || isBotTyping || isEndingChat}>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="24" height="24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}




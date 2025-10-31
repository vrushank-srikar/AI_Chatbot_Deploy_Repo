






import React, { useEffect, useState, useCallback, useRef } from "react";
import axios from "axios";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  PointElement,
  LineElement,
} from "chart.js";
import { Bar, Doughnut, Line } from "react-chartjs-2";
import { io } from "socket.io-client";
import "../styles/AdminDashboard.css";

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  PointElement,
  LineElement
);

export default function AdminDashboard() {
  const [token] = useState(localStorage.getItem("token") || "");
  const [allCases, setAllCases] = useState([]);
  const [orders, setOrders] = useState([]);
  const [selectedCase, setSelectedCase] = useState(null);

  // unified chat (user/bot/agent)
  const [threadMessages, setThreadMessages] = useState([]);
  const chatBottomRef = useRef(null);
  const socketRef = useRef(null);

  const [responseMessage, setResponseMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [activeTab, setActiveTab] = useState("new");
  const [trendChartData, setTrendChartData] = useState({
    labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    datasets: [
      {
        label: "New Cases",
        data: [0, 0, 0, 0, 0, 0, 0],
        borderColor: "rgba(59,130,246,1)",
        backgroundColor: "rgba(59,130,246,0.1)",
        tension: 0.4,
      },
      {
        label: "Resolved Cases",
        data: [0, 0, 0, 0, 0, 0, 0],
        borderColor: "rgba(16,185,129,1)",
        backgroundColor: "rgba(16,185,129,0.1)",
        tension: 0.4,
      },
    ],
  });

  /* ---------- Case-memory text formatting helpers ---------- */
  const cleanTranscript = (text = "") =>
    text
      .replace(/\b(Agent|User|Support Bot)\s*:\s*/gi, "")
      .replace(/\|\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

  const pickResolutionSummary = (text = "") => {
    const m = text.match(/Resolution Summary\s*:\s*([\s\S]+)/i);
    if (m && m[1]) return m[1].trim();
    const parts = text.split(/(?<=[.?!])\s+/).slice(0, 2);
    return parts.join(" ").trim();
  };

  const buildMemoryReply = (
    rawMessage = "",
    { orderId, productName, missingQty } = {}
  ) => {
    const cleaned = cleanTranscript(rawMessage);
    const summary = pickResolutionSummary(cleaned);

    const action = /refund/i.test(summary)
      ? "issue a refund"
      : /replace|replacement/i.test(summary)
      ? "send a replacement"
      : "resolve this for you";

    const qtyPart =
      missingQty && productName
        ? `${missingQty} ${productName}${Number(missingQty) > 1 ? "s" : ""}`
        : productName
        ? `the ${productName}`
        : "the missing item";

    const orderPart = orderId ? ` for order ${orderId}` : "";

    return `I’ve handled a similar case before: ${summary}. For your case${orderPart}, I can ${action} for ${qtyPart} right away or connect you with a specialist. Would you like me to proceed?`;
  };

  /* ---------------- Socket.IO: create once ---------------- */
  useEffect(() => {
    if (!token) return;

    const s = io("http://localhost:5000", {
      transports: ["websocket"],
      auth: { token },
    });

    s.on("connect_error", (e) =>
      console.warn("socket connect_error:", e?.message || e)
    );
    s.on("disconnect", (r) => console.log("socket disconnected:", r));

    socketRef.current = s;
    return () => {
      try {
        s.disconnect();
      } catch {}
      socketRef.current = null;
    };
  }, [token]);

  /* ---------------- Join/leave current case room ---------------- */
  useEffect(() => {
    const caseId = selectedCase?._id;
    if (!socketRef.current) return;

    if (caseId) {
      socketRef.current.emit("join_case", { caseId });
    }
    return () => {
      if (caseId) {
        socketRef.current?.emit("leave_case", { caseId });
      }
    };
  }, [selectedCase?._id]);

  /* ---------------- Live listeners with de-dupe ---------------- */
  const safeAppend = useCallback(
    (payload, senderFallback) => {
      // pretty-print case-memory suggestions before appending
      if ((payload?.source || senderFallback) === "case-memory") {
        const pretty = buildMemoryReply(payload.message, {
          orderId: selectedCase?.orderId,
          productName:
            selectedCase?.productName ||
            selectedCase?.product ||
            selectedCase?.itemName,
          missingQty: selectedCase?.missingQty || 1,
        });
        payload = { ...payload, message: pretty };
      }

      const key =
        payload.id ||
        payload._id ||
        `${payload.source || senderFallback}|${payload.timestamp}|${payload.message}`;

      setThreadMessages((prev) => {
        if (prev.some((m) => m._id === key || m.id === key || m.key === key)) {
          return prev;
        }
        return [
          ...prev,
          {
            _id: key,
            key,
            source: payload.source || senderFallback || "bot",
            sender:
              payload.sender ||
              (payload.source === "agent" ? "agent" : senderFallback || "bot"),
            message: payload.message,
            timestamp: payload.timestamp || Date.now(),
            caseId: payload.caseId || selectedCase?._id,
            prompt: payload.prompt,
          },
        ];
      });
    },
    [selectedCase?._id]
  );

  useEffect(() => {
    if (!socketRef.current) return;

    const onChatReply = (payload = {}) => {
      if (!selectedCase) return;
      // Only handle non-agent messages here (avoid duplicates)
      if (payload.source === "agent") return;

      const { caseId, orderId, productIndex } = payload;
      if (
        caseId === selectedCase._id ||
        (orderId === selectedCase.orderId &&
          Number(productIndex) === Number(selectedCase.productIndex))
      ) {
        safeAppend(payload, payload.source || "bot");
      }
    };

    const onCaseMessage = (payload = {}) => {
      if (!selectedCase) return;
      if (payload.caseId === selectedCase._id && payload.message) {
        safeAppend({ ...payload, source: "agent" }, "agent");
      }
    };

    socketRef.current.on("chat:reply", onChatReply);
    socketRef.current.on("case:message", onCaseMessage);

    return () => {
      socketRef.current?.off("chat:reply", onChatReply);
      socketRef.current?.off("case:message", onCaseMessage);
    };
  }, [selectedCase?._id, safeAppend]);

  // scroll to bottom on new messages
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [threadMessages]);

  /* ---------------- Data fetchers ---------------- */
  const fetchCases = useCallback(
    async (retryCount = 0) => {
      setLoading(true);
      setError("");
      try {
        const response = await axios.get(
          `http://localhost:5000/api/admin/cases?_t=${Date.now()}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );

        const casesRaw = response.data.cases || [];
        const cases = casesRaw.map((c) => ({
          ...c,
          responses: Array.isArray(c.responses) ? c.responses : [],
        }));

        const sorted = cases.sort((a, b) => {
          if (a.priority === "high" && b.priority !== "high") return -1;
          if (a.priority !== "high" && b.priority === "high") return 1;
          return new Date(b.createdAt) - new Date(a.createdAt);
        });
        setAllCases(sorted);
      } catch (err) {
        if (retryCount < 2)
          setTimeout(() => fetchCases(retryCount + 1), 1000);
        else setError(err.response?.data?.error || "Failed to fetch cases");
      } finally {
        setLoading(false);
      }
    },
    [token]
  );

  const fetchOrders = useCallback(
    async (retryCount = 0) => {
      try {
        const resp = await axios.get(
          `http://localhost:5000/api/admin/orders?_t=${Date.now()}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        setOrders(resp.data.orders || []);
      } catch (err) {
        if (retryCount < 2)
          setTimeout(() => fetchOrders(retryCount + 1), 1000);
        else
          console.warn("Failed to fetch orders:", err.response?.data || err.message);
      }
    },
    [token]
  );

  // unified thread for selected case
  const fetchUnifiedThread = useCallback(
    async (caseId) => {
      if (!caseId) return;
      try {
        const { data } = await axios.get(
          `http://localhost:5000/api/admin/case/${caseId}/unified-thread?_t=${Date.now()}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        setThreadMessages(Array.isArray(data.thread) ? data.thread : []);
        // room join handled by join/leave effect
      } catch (e) {
        console.warn("Failed to load thread:", e?.response?.data || e?.message);
        setThreadMessages([]);
      }
    },
    [token]
  );

  // mount
  useEffect(() => {
    if (token) {
      fetchCases();
      fetchOrders();
    } else {
      setError("No authentication token found. Please log in.");
      window.location.href = "/";
    }
  }, [token, fetchCases, fetchOrders]);

  // when user clicks a case, load its conversation
  const handleSelectCase = (c) => {
    setSelectedCase(c);
    setThreadMessages([]);
    fetchUnifiedThread(c._id);
  };

  /* --------- Case status & responses --------- */
  const updateCaseStatus = async (caseId, newStatus) => {
    setLoading(true);
    setError("");
    setSuccessMessage("");
    try {
      const response = await axios.put(
        `http://localhost:5000/api/case/${caseId}`,
        { status: newStatus },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await fetchCases();
      if (selectedCase?._id === caseId) {
        setSelectedCase(response.data.case);
      }
      setSuccessMessage(
        `Case ${newStatus === "resolved" ? "closed" : "reopened"} successfully`
      );
      setTimeout(() => setSuccessMessage(""), 3000);
    } catch (err) {
      setError(err.response?.data?.error || "Failed to update case status");
    } finally {
      setLoading(false);
    }
  };

  const addResponse = async (caseId) => {
    if (!responseMessage.trim()) {
      setError("Response message cannot be empty");
      return;
    }
    setLoading(true);
    setError("");
    setSuccessMessage("");
    try {
      const response = await axios.post(
        `http://localhost:5000/api/case/${caseId}/response`,
        { message: responseMessage },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await fetchCases();
      if (selectedCase?._id === caseId) {
        setSelectedCase(response.data.case);
      }
      // No optimistic append; we rely on the single echo from socket
      setResponseMessage("");
      setSuccessMessage("Response sent successfully");
      setTimeout(() => setSuccessMessage(""), 3000);
    } catch (err) {
      setError(err.response?.data?.error || "Failed to add response");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    setLoading(true);
    setError("");
    try {
      await axios.post(
        "http://localhost:5000/api/logout",
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch (err) {
      setError(err.response?.data?.error || "Logout failed");
    } finally {
      localStorage.removeItem("token");
      window.location.href = "/";
    }
  };

  /* ---------------- Derived data & charts ---------------- */
  useEffect(() => {
    if (allCases.length > 0) {
      const newByDay = new Array(7).fill(0);
      const resolvedByDay = new Array(7).fill(0);

      allCases.forEach((c) => {
        const createdDay = new Date(c.createdAt || Date.now()).getDay();
        newByDay[createdDay]++;
        if (c.status === "resolved") {
          const updatedDay = new Date(c.updatedAt || c.createdAt || Date.now()).getDay();
          resolvedByDay[updatedDay]++;
        }
      });

      const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const newData = [
        newByDay[1],
        newByDay[2],
        newByDay[3],
        newByDay[4],
        newByDay[5],
        newByDay[6],
        newByDay[0],
      ];
      const resolvedData = [
        resolvedByDay[1],
        resolvedByDay[2],
        resolvedByDay[3],
        resolvedByDay[4],
        resolvedByDay[5],
        resolvedByDay[6],
        resolvedByDay[0],
      ];

      setTrendChartData({
        labels: days,
        datasets: [
          {
            label: "New Cases",
            data: newData,
            borderColor: "rgba(59,130,246,1)",
            backgroundColor: "rgba(59,130,246,0.1)",
            tension: 0.4,
          },
          {
            label: "Resolved Cases",
            data: resolvedData,
            borderColor: "rgba(16,185,129,1)",
            backgroundColor: "rgba(16,185,129,0.1)",
            tension: 0.4,
          },
        ],
      });
    } else {
      setTrendChartData((prev) => ({
        ...prev,
        datasets: prev.datasets.map((d) => ({ ...d, data: [0, 0, 0, 0, 0, 0, 0] })),
      }));
    }
  }, [allCases]);

  const hasAgentReply = (c) =>
    Array.isArray(c?.responses) && c.responses.some((r) => r && r.adminId != null);

  const newCases = allCases.filter((c) => !hasAgentReply(c));
  const pendingCases = allCases.filter(
    (c) => hasAgentReply(c) && c.status !== "resolved"
  );
  const closedCases = allCases.filter((c) => c.status === "resolved");

  const displayedCases =
    activeTab === "new" ? newCases : activeTab === "pending" ? pendingCases : closedCases;

  const handleKeyPress = (e, caseId) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      addResponse(caseId);
    }
  };

  const totalCases = allCases.length;
  const highPriorityCases = allCases.filter((c) => c.priority === "high").length;
  const resolutionRate =
    totalCases > 0 ? Math.round((closedCases.length / totalCases) * 100) : 0;

  const statusChartData = {
    labels: ["New Cases", "Pending Cases", "Closed Cases"],
    datasets: [
      {
        data: [newCases.length, pendingCases.length, closedCases.length],
        backgroundColor: [
          "rgba(59,130,246,0.8)",
          "rgba(245,158,11,0.8)",
          "rgba(16,185,129,0.8)",
        ],
        borderColor: [
          "rgba(59,130,246,1)",
          "rgba(245,158,11,1)",
          "rgba(16,185,129,1)",
        ],
        borderWidth: 2,
      },
    ],
  };

  const possibleDomains = ["E-commerce", "Travel", "Telecommunications", "Banking Services"];
  const domainCounts = possibleDomains.map(
    (d) => allCases.filter((c) => c.domain === d).length
  );
  const domainChartData = {
    labels: possibleDomains,
    datasets: [
      {
        label: "Cases by Domain",
        data: domainCounts,
        backgroundColor: [
          "rgba(139,92,246,0.8)",
          "rgba(59,130,246,0.8)",
          "rgba(16,185,129,0.8)",
          "rgba(245,158,11,0.8)",
        ],
        borderColor: [
          "rgba(139,92,246,1)",
          "rgba(59,130,246,1)",
          "rgba(16,185,129,1)",
          "rgba(245,158,11,1)",
        ],
        borderWidth: 2,
      },
    ],
  };

  const priorityChartData = {
    labels: ["High Priority", "Low Priority"],
    datasets: [
      {
        data: [highPriorityCases, totalCases - highPriorityCases],
        backgroundColor: ["rgba(239,68,68,0.8)", "rgba(34,197,94,0.8)"],
        borderColor: ["rgba(239,68,68,1)", "rgba(34,197,94,1)"],
        borderWidth: 2,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: "bottom", labels: { padding: 20, usePointStyle: true } },
    },
  };

  return (
    <div className="admin-dashboard">
      <div className="dashboard-header">
        <h1>Admin Dashboard</h1>
        <button onClick={handleLogout} className="logout-btn">
          Logout
        </button>
      </div>

      {loading && <div className="loading">Loading...</div>}
      {error && <div className="error-message">{error}</div>}
      {successMessage && <div className="success-message">{successMessage}</div>}

      {/* Stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <h3>Total Cases</h3>
          <div className="stat-number">{totalCases}</div>
          <div className="stat-change neutral">All time</div>
        </div>
        <div className="stat-card">
          <h3>High Priority</h3>
          <div className="stat-number">{highPriorityCases}</div>
          <div className="stat-change negative">Needs attention</div>
        </div>
        <div className="stat-card">
          <h3>Resolution Rate</h3>
          <div className="stat-number">{resolutionRate}%</div>
          <div className="stat-change positive">+5% from last week</div>
        </div>
        <div className="stat-card">
          <h3>Total Orders</h3>
          <div className="stat-number">{orders.length}</div>
          <div className="stat-change neutral">From users</div>
        </div>
      </div>

      {/* Charts */}
      <div className="charts-section">
        <div className="chart-card">
          <h3>Case Status Distribution</h3>
          <div className="chart-container">
            <Doughnut data={statusChartData} options={chartOptions} />
          </div>
        </div>
        <div className="chart-card">
          <h3>Priority Distribution</h3>
          <div className="chart-container">
            <Doughnut data={priorityChartData} options={chartOptions} />
          </div>
        </div>
        <div className="chart-card">
          <h3>Cases by Domain</h3>
          <div className="chart-container">
            <Bar data={domainChartData} options={chartOptions} />
          </div>
        </div>
        <div className="chart-card">
          <h3>Weekly Trend</h3>
          <div className="chart-container">
            <Line data={trendChartData} options={chartOptions} />
          </div>
        </div>
      </div>

      {/* Case list */}
      <div className="cases-nav">
        <button
          className={`nav-tab ${activeTab === "new" ? "active" : ""}`}
          onClick={() => setActiveTab("new")}
        >
          New ({newCases.length})
        </button>
        <button
          className={`nav-tab ${activeTab === "pending" ? "active" : ""}`}
          onClick={() => setActiveTab("pending")}
        >
          Pending ({pendingCases.length})
        </button>
        <button
          className={`nav-tab ${activeTab === "closed" ? "active" : ""}`}
          onClick={() => setActiveTab("closed")}
        >
          Closed ({closedCases.length})
        </button>
      </div>

      <div className="cases-section">
        <h2>{activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} Cases</h2>
        <div className="cases-list">
          {displayedCases.length === 0 ? (
            <p className="no-cases">No {activeTab} cases found.</p>
          ) : (
            displayedCases.map((c) => (
              <div
                key={c._id}
                className={`case-card ${c.priority === "high" ? "high-priority" : ""}`}
                onClick={() => handleSelectCase(c)}
              >
                <p>
                  <strong>Case ID:</strong>{" "}
                  {c?._id ? String(c._id).slice(-6) : "N/A"}
                </p>
                <p>
                  <strong>User:</strong> {c?.userId?.name || "Unknown"}
                </p>
                <p>
                  <strong>Description:</strong> {c?.description || "—"}
                </p>
                <p>
                  <strong>Priority:</strong> {c?.priority || "low"}
                </p>
                <p>
                  <strong>Domain:</strong> {c?.domain || "N/A"}
                </p>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Case popup with REAL chat */}
      {selectedCase && (
        <div className="case-popup">
          <div className="case-popup-content">
            <div className="case-popup-header">
              <h3>Case #{String(selectedCase._id).slice(-6)}</h3>
              <button
                className="close-popup"
                onClick={() => {
                  setSelectedCase(null);
                  setThreadMessages([]);
                }}
              >
                &times;
              </button>
            </div>

            <div className="case-details">
              <p>
                <strong>User:</strong> {selectedCase?.userId?.name || "Unknown"} (
                {selectedCase?.userId?.email || "N/A"})
              </p>
              <p>
                <strong>Order ID:</strong> {selectedCase?.orderId || "N/A"}
              </p>
              <p>
                <strong>Product Index:</strong>{" "}
                {selectedCase?.productIndex ?? "N/A"}
              </p>
              <p>
                <strong>Description:</strong>{" "}
                {selectedCase?.description || "—"}
              </p>
              <p>
                <strong>Priority:</strong> {selectedCase?.priority || "low"}
              </p>
              <p>
                <strong>Status:</strong> {selectedCase?.status || "open"}
              </p>
              <p>
                <strong>Domain:</strong> {selectedCase?.domain || "N/A"}
              </p>
              <p>
                <strong>Created:</strong>{" "}
                {new Date(selectedCase?.createdAt || Date.now()).toLocaleString()}
              </p>
              <p>
                <strong>Updated:</strong>{" "}
                {new Date(selectedCase?.updatedAt || Date.now()).toLocaleString()}
              </p>
            </div>

            {/* Chat history viewer */}
            <div className="chat-history">
              {threadMessages.length === 0 ? (
                <p>No chat history available.</p>
              ) : (
                threadMessages.map((m, i) => (
                  <div
                    key={m._id || m.id || m.key || `${m.timestamp || i}-${i}`}
                    className={m.sender === "agent" ? "admin-message" : "user-message"}
                  >
                    <p>
                      <strong>
                        {m.sender === "agent"
                          ? "Agent"
                          : m.source === "faq"
                          ? "FAQ"
                          : m.source === "case-memory"
                          ? "Suggested Resolution"
                          : m.source === "refund"
                          ? "System"
                          : "User/Bot"}
                      </strong>{" "}
                      ({new Date(m.timestamp || Date.now()).toLocaleString()}):
                      <br />
                      {m.message}
                      {m.prompt ? (
                        <>
                          <br />
                          <em style={{ opacity: 0.7 }}>User: {m.prompt}</em>
                        </>
                      ) : null}
                    </p>
                  </div>
                ))
              )}
              <div ref={chatBottomRef} />
            </div>

            <div className="response-section">
              <textarea
                value={responseMessage}
                onChange={(e) => setResponseMessage(e.target.value)}
                onKeyDown={(e) => handleKeyPress(e, selectedCase._id)}
                placeholder="Type your response..."
                className="response-textarea"
              />
              <button
                onClick={() => addResponse(selectedCase._id)}
                className="response-button"
                disabled={loading}
              >
                Send Response
              </button>
            </div>

            <div className="status-toggle">
              <label>
                Case Status:
                <input
                  type="checkbox"
                  checked={selectedCase.status === "resolved"}
                  onChange={() =>
                    updateCaseStatus(
                      selectedCase._id,
                      selectedCase.status === "resolved" ? "open" : "resolved"
                    )
                  }
                  disabled={loading}
                />
                <span className="toggle-switch"></span>
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

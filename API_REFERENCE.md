# YNT Dashboard API Reference
## Complete REST API Documentation

---

## 📋 API Base URL

```
http://localhost:3001/api
```

## 🔐 Authentication

All endpoints (except login) require JWT token in header:

```bash
Authorization: Bearer YOUR_JWT_TOKEN
```

**Example request with curl:**
```bash
curl -H "Authorization: Bearer eyJhbGc..." \
     http://localhost:3001/api/orders
```

---

## 🔑 Authentication Endpoints

### Login
**Endpoint:** `POST /auth/login`

**Request:**
```json
{
  "username": "admin",
  "password": "admin123"
}
```

**Response (200 OK):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "admin",
    "full_name": "Administrator",
    "role": "Administrator"
  }
}
```

**Error (401 Unauthorized):**
```json
{
  "error": "Invalid username or password"
}
```

---

### Get Current User
**Endpoint:** `GET /auth/me`

**Request:**
```bash
GET /api/auth/me
Authorization: Bearer TOKEN
```

**Response (200 OK):**
```json
{
  "id": 1,
  "username": "admin",
  "full_name": "Administrator",
  "role": "Administrator",
  "is_active": 1
}
```

---

### Logout
**Endpoint:** `POST /auth/logout`

**Request:**
```bash
POST /api/auth/logout
Authorization: Bearer TOKEN
```

**Response (200 OK):**
```json
{
  "message": "Logged out successfully"
}
```

---

## 📦 Orders Endpoints

### Get All Orders
**Endpoint:** `GET /orders`

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| page | integer | No | ?page=1 |
| limit | integer | No | ?limit=50 |
| status | string | No | ?status=Pending |
| customer | string | No | ?customer=John |

**Response (200 OK):**
```json
{
  "total": 150,
  "page": 1,
  "limit": 50,
  "orders": [
    {
      "id": 1,
      "order_ref": "ORD-20260525-001",
      "customer": "John Doe",
      "phone": "03001234567",
      "product": "Phone Case",
      "qty": 2,
      "cod_amount": 1500,
      "status": "Pending",
      "courier": "TCS",
      "tracking_no": "TCS123456",
      "order_date": "2026-05-25T10:30:00Z",
      "notes": "Fragile item",
      "created_at": "2026-05-25T10:30:00Z"
    },
    ...
  ]
}
```

---

### Get Single Order
**Endpoint:** `GET /orders/:id`

**Parameters:**
```
:id = Order ID (integer)
```

**Response (200 OK):**
```json
{
  "id": 1,
  "order_ref": "ORD-20260525-001",
  "customer": "John Doe",
  "phone": "03001234567",
  "product": "Phone Case",
  "qty": 2,
  "cod_amount": 1500,
  "status": "Pending",
  "courier": "TCS",
  "tracking_no": "TCS123456",
  "order_date": "2026-05-25",
  "shipping_address": "123 Main St, City",
  "notes": "Fragile item",
  "created_at": "2026-05-25T10:30:00Z",
  "updated_at": "2026-05-25T10:30:00Z"
}
```

---

### Create Order
**Endpoint:** `POST /orders`

**Request Body:**
```json
{
  "customer": "John Doe",
  "phone": "03001234567",
  "product": "Phone Case",
  "qty": 2,
  "cod_amount": 1500,
  "courier": "TCS",
  "shipping_address": "123 Main St, City",
  "notes": "Fragile item"
}
```

**Response (201 Created):**
```json
{
  "id": 1,
  "order_ref": "ORD-20260525-001",
  "customer": "John Doe",
  "status": "Pending",
  ...
}
```

---

### Update Order
**Endpoint:** `PUT /orders/:id`

**Request Body:** (any fields to update)
```json
{
  "status": "Shipped",
  "tracking_no": "TCS123456",
  "notes": "Shipped on 2026-05-26"
}
```

**Response (200 OK):**
```json
{
  "id": 1,
  "order_ref": "ORD-20260525-001",
  "status": "Shipped",
  "tracking_no": "TCS123456",
  ...
}
```

---

### Delete Order
**Endpoint:** `DELETE /orders/:id`

**Response (200 OK):**
```json
{
  "message": "Order deleted successfully"
}
```

---

### Get Order Statistics
**Endpoint:** `GET /orders/stats`

**Response (200 OK):**
```json
{
  "total_orders": 150,
  "by_status": {
    "Pending": 45,
    "Confirmed": 30,
    "Shipped": 50,
    "Delivered": 20,
    "Cancelled": 5
  },
  "today": 12,
  "this_week": 85,
  "this_month": 150,
  "avg_daily": 5.2,
  "total_cod_value": 225000
}
```

---

## 📊 Inventory Endpoints

### Get All Inventory
**Endpoint:** `GET /inventory`

**Query Parameters:**
| Param | Type | Example |
|-------|------|---------|
| page | integer | ?page=1 |
| limit | integer | ?limit=50 |
| type | string | ?type=Product |
| alert | boolean | ?alert=true (low stock only) |

**Response (200 OK):**
```json
{
  "total": 125,
  "items": [
    {
      "item_id": "P001",
      "name": "Phone Case",
      "sku": "SKU-001",
      "type": "Product",
      "stock": 50,
      "reorder_point": 20,
      "cost_price": 500,
      "selling_price": 1500,
      "supplier": "ABC Wholesale",
      "last_stock_check": "2026-05-25T10:30:00Z",
      "created_at": "2026-05-25T10:30:00Z"
    },
    ...
  ]
}
```

---

### Get Low Stock Alerts
**Endpoint:** `GET /inventory/alerts`

**Response (200 OK):**
```json
{
  "critical": [
    {
      "item_id": "P005",
      "name": "Packaging Material",
      "stock": 5,
      "reorder_point": 15,
      "shortage": 10
    }
  ],
  "warning": [
    {
      "item_id": "P003",
      "name": "USB Cable",
      "stock": 25,
      "reorder_point": 30,
      "shortage": 5
    }
  ]
}
```

---

### Add Inventory Item
**Endpoint:** `POST /inventory`

**Request Body:**
```json
{
  "item_id": "P001",
  "name": "Phone Case",
  "sku": "SKU-001",
  "type": "Product",
  "stock": 50,
  "reorder_point": 20,
  "cost_price": 500,
  "selling_price": 1500,
  "supplier": "ABC Wholesale"
}
```

**Response (201 Created):**
```json
{
  "item_id": "P001",
  "name": "Phone Case",
  "stock": 50,
  ...
}
```

---

### Update Inventory
**Endpoint:** `PUT /inventory/:id`

**Request Body:**
```json
{
  "stock": 75,
  "reorder_point": 25
}
```

**Response (200 OK):**
```json
{
  "item_id": "P001",
  "stock": 75,
  "reorder_point": 25,
  ...
}
```

---

## 💰 Expenses Endpoints

### Get All Expenses
**Endpoint:** `GET /expenses`

**Query Parameters:**
| Param | Type | Example |
|-------|------|---------|
| page | integer | ?page=1 |
| category | string | ?category=Load |
| date_from | date | ?date_from=2026-05-01 |
| date_to | date | ?date_to=2026-05-31 |

**Response (200 OK):**
```json
{
  "total": 45,
  "expenses": [
    {
      "expense_ref": "EXP-20260525-001",
      "category": "Load",
      "item_name": "Fuel for delivery van",
      "quantity": 30,
      "unit_price": 100,
      "total_amount": 3000,
      "payment_method": "Cash",
      "date": "2026-05-25",
      "notes": "Regular fuel purchase",
      "created_at": "2026-05-25T10:30:00Z"
    },
    ...
  ]
}
```

---

### Create Expense
**Endpoint:** `POST /expenses`

**Request Body:**
```json
{
  "category": "Load",
  "item_name": "Fuel for delivery van",
  "quantity": 30,
  "unit_price": 100,
  "payment_method": "Cash",
  "date": "2026-05-25",
  "notes": "Regular fuel purchase"
}
```

**Response (201 Created):**
```json
{
  "expense_ref": "EXP-20260525-001",
  "category": "Load",
  "total_amount": 3000,
  ...
}
```

---

### Get Expense Summary
**Endpoint:** `GET /expenses/summary`

**Query Parameters:**
| Param | Type | Example |
|-------|------|---------|
| month | integer | ?month=5 |
| year | integer | ?year=2026 |

**Response (200 OK):**
```json
{
  "period": "May 2026",
  "by_category": {
    "Load": 25000,
    "Utility": 8000,
    "Supplies": 12000,
    "Other": 5000
  },
  "total": 50000,
  "daily_avg": 1612.9
}
```

---

## 🎫 Pickups Endpoints

### Get All Pickups
**Endpoint:** `GET /pickups`

**Response (200 OK):**
```json
[
  {
    "pickup_id": 1,
    "pickup_date": "2026-05-25",
    "location": "Warehouse A",
    "items_count": 45,
    "status": "Completed",
    "courier": "TCS",
    "notes": "All items collected",
    "created_at": "2026-05-25T08:00:00Z"
  },
  ...
]
```

---

### Create Pickup
**Endpoint:** `POST /pickups`

**Request Body:**
```json
{
  "pickup_date": "2026-05-26",
  "location": "Warehouse A",
  "items_count": 50,
  "courier": "TCS",
  "notes": "Scheduled pickup"
}
```

---

## 📱 Scans Endpoints

### Get All Scans
**Endpoint:** `GET /scans`

**Query Parameters:**
| Param | Type | Example |
|-------|------|---------|
| item_id | string | ?item_id=P001 |
| scan_type | string | ?scan_type=In |
| date | date | ?date=2026-05-25 |

**Response (200 OK):**
```json
[
  {
    "scan_id": 1,
    "item_id": "P001",
    "scan_code": "SKU-001",
    "scan_location": "Warehouse A - Shelf 5",
    "scan_type": "In",
    "scanned_by": "admin",
    "scan_time": "2026-05-25T10:30:00Z",
    "notes": "Stock received from supplier"
  },
  ...
]
```

---

### Create Scan
**Endpoint:** `POST /scans`

**Request Body:**
```json
{
  "item_id": "P001",
  "scan_code": "SKU-001",
  "scan_location": "Warehouse A - Shelf 5",
  "scan_type": "In",
  "notes": "Stock received from supplier"
}
```

---

## 📣 Announcements Endpoints

### Get All Announcements
**Endpoint:** `GET /announcements`

**Response (200 OK):**
```json
[
  {
    "id": 1,
    "title": "System Maintenance",
    "content": "System will be down on 2026-05-27 from 2-4 AM",
    "priority": "High",
    "posted_by": "admin",
    "posted_date": "2026-05-25T15:00:00Z",
    "expires_at": "2026-05-27T06:00:00Z"
  },
  ...
]
```

---

### Create Announcement
**Endpoint:** `POST /announcements`

**Request Body:**
```json
{
  "title": "System Maintenance",
  "content": "System will be down on 2026-05-27 from 2-4 AM",
  "priority": "High",
  "expires_at": "2026-05-27T06:00:00Z"
}
```

---

## 🔑 API Keys Endpoints

### Get API Keys
**Endpoint:** `GET /api-keys`

**Response (200 OK):**
```json
[
  {
    "id": 1,
    "name": "Mobile App Key",
    "key_hash": "sha256_hash_here",
    "usage_scope": "READ:ORDERS,READ:INVENTORY",
    "created_by": "admin",
    "created_at": "2026-05-20T10:00:00Z",
    "last_used": "2026-05-25T15:30:00Z",
    "is_active": 1
  },
  ...
]
```

---

### Create API Key
**Endpoint:** `POST /api-keys`

**Request Body:**
```json
{
  "name": "Mobile App Key",
  "usage_scope": "READ:ORDERS,READ:INVENTORY"
}
```

**Response (201 Created):**
```json
{
  "id": 1,
  "name": "Mobile App Key",
  "key": "ynt_abc123def456...",
  "key_hash": "sha256_hash_here",
  "usage_scope": "READ:ORDERS,READ:INVENTORY",
  "message": "Save this key somewhere safe, you won't see it again!"
}
```

---

## Error Responses

### 400 Bad Request
```json
{
  "error": "Validation failed",
  "details": {
    "customer": "Customer name is required",
    "qty": "Quantity must be a positive number"
  }
}
```

### 401 Unauthorized
```json
{
  "error": "Unauthorized",
  "message": "Missing or invalid authentication token"
}
```

### 403 Forbidden
```json
{
  "error": "Forbidden",
  "message": "Your role does not have permission for this action"
}
```

### 404 Not Found
```json
{
  "error": "Not found",
  "message": "Order with ID 999 not found"
}
```

### 500 Internal Server Error
```json
{
  "error": "Server error",
  "message": "An unexpected error occurred. Please try again later."
}
```

---

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | OK - Request successful |
| 201 | Created - Resource created |
| 204 | No Content - Success, no data |
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Auth required |
| 403 | Forbidden - No permission |
| 404 | Not Found - Resource not found |
| 500 | Server Error - Internal error |

---

## Rate Limiting

No rate limiting currently implemented.  
For production, consider adding:
- 100 requests per minute per user
- 10,000 requests per hour per API key
- Exponential backoff on errors

---

## Pagination

**Supported on endpoints returning multiple records:**

```
?page=1&limit=50
```

**Response includes:**
```json
{
  "total": 150,
  "page": 1,
  "limit": 50,
  "pages": 3,
  "data": [...]
}
```

---

## Date Format

All dates in API responses use ISO 8601 format:
```
2026-05-25T10:30:00Z
```

**Accept formats in requests:**
- ISO 8601: `2026-05-25T10:30:00Z`
- Date only: `2026-05-25`

---

## Example: Complete Order Flow

### 1. Login
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# Response: { "token": "...", "user": {...} }
```

### 2. Create Order
```bash
curl -X POST http://localhost:3001/api/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "customer": "John Doe",
    "phone": "03001234567",
    "product": "Phone Case",
    "qty": 2,
    "cod_amount": 1500,
    "courier": "TCS"
  }'

# Response: { "id": 1, "order_ref": "ORD-20260525-001", ... }
```

### 3. Update Order Status
```bash
curl -X PUT http://localhost:3001/api/orders/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "status": "Shipped",
    "tracking_no": "TCS123456"
  }'

# Response: { "id": 1, "status": "Shipped", ... }
```

### 4. Get Order Details
```bash
curl -X GET http://localhost:3001/api/orders/1 \
  -H "Authorization: Bearer YOUR_TOKEN"

# Response: { "id": 1, "order_ref": "ORD-20260525-001", ... }
```

---

## Testing the API

### Using cURL
```bash
curl -X GET http://localhost:3001/api/orders \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Using Postman
1. Import base URL: `http://localhost:3001/api`
2. Set Authorization: Bearer Token
3. Create requests for each endpoint

### Using JavaScript
```javascript
const token = 'YOUR_TOKEN';

fetch('http://localhost:3001/api/orders', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
})
.then(res => res.json())
.then(data => console.log(data));
```

---

**API Version:** 1.0  
**Last Updated:** May 29, 2026

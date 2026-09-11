// CONFIGURATION: Replace with your actual Google Sheet & Google Doc Template IDs
const SPREADSHEET_ID = '1vWy18L-Y7BchXI4OA_33d5egwj0oSI3ZudJ2Z0QbdIk';
//const TEMPLATE_DOC_ID = '1zFbuiHXRZM4oK2YWfjGfCzWn_7B8peRZCIf6Gw_fpOs';
const TEMPLATE_DOC_ID = '1yj-dqxB2aGgiAWvmRXjX6Bdoxniv3dOP9cox9qKbM4U';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('Generate Claim Statement')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

/** Fetch initial dropdown data: Activities & Associates */
function getInitialData() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  
  // 1. Fetch Activity List
  let activities = [];
  const actSheet = ss.getSheetByName('Activity_List');
  if (actSheet) {
    const actData = actSheet.getDataRange().getValues();
    for (let i = 1; i < actData.length; i++) {
      if (actData[i][0]) activities.push(actData[i][0].toString().trim());
    }
  }

  // 2. Fetch Associates List
  let associates = [];
  const assocSheet = ss.getSheetByName('Associates');
  if (assocSheet) {
    const assocData = assocSheet.getDataRange().getValues();
    // Headers: SL No, Name, Designation, Contact
    for (let i = 1; i < assocData.length; i++) {
      if (assocData[i][1]) {
        associates.push({
          name: assocData[i][1].toString().trim(),
          designation: assocData[i][2] ? assocData[i][2].toString().trim() : '',
          contact: assocData[i][3] ? assocData[i][3].toString().trim() : ''
        });
      }
    }
  }

  return { activities: activities, associates: associates };
}

/** Fetch line items for a specific selected activity sheet */
function getActivityMaterials(activityName) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(activityName);
  let materials = [];
  
  if (sheet) {
    const data = sheet.getDataRange().getValues();
    // Headers: SL No, Line_Items, Quantity
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] || data[i][2]) {
        materials.push({
          item: data[i][1] ? data[i][1].toString().trim() : '',
          quantity: data[i][2] ? data[i][2].toString().trim() : ''
        });
      }
    }
  }
  return materials;
}

function generateClaimStatementPDF(formData) {
  try {
    const templateFile = DriveApp.getFileById(TEMPLATE_DOC_ID);
    const newDocCopy = templateFile.makeCopy('ClaimStatement_' + (formData.corporate || 'Doc'));
    const doc = DocumentApp.openById(newDocCopy.getId());
    const body = doc.getBody();

    // 1. Standard Fields
    body.replaceText('{{Corporate}}', formData.corporate || '');
    body.replaceText('{{Activity_Name}}', formData.activityName || '');
    body.replaceText('{{Address}}', formData.address || '');
    body.replaceText('{{Letter_Date}}', formData.letterDate || '');
    body.replaceText('{{Activity_Date}}', formData.activityDate || '');
    body.replaceText('{{Location}}', formData.location || '');
    body.replaceText('{{Associate_Name}}', formData.signoffName || '');
    body.replaceText('{{Designation}}', formData.signoffDesignation || '');
    body.replaceText('{{Phone_Number}}', formData.signoffPhone || '');

    // 2. Process Materials Table (up to 20 slot placeholders in template: {{M1_SL}}, {{M2_SL}}, etc.)
    const materials = formData.materials || [];
    for (let i = 1; i <= 20; i++) {
      const tag = `{{M${i}_SL}}`;
      const mat = materials[i - 1];

      if (mat) {
        // Data exists: Populate placeholders
        body.replaceText(tag, i.toString());
        body.replaceText(`{{M${i}_NAME}}`, mat.item || '');
        body.replaceText(`{{M${i}_QTY}}`, mat.quantity || '');
      } else {
        // No data: Delete the whole row completely from the table
        removeRowByTag(body, tag);
      }
    }

    // 3. Process Representatives Table (up to 10 slot placeholders: {{R1_SL}}, {{R2_SL}}, etc.)
    const reps = formData.representatives || [];
    for (let j = 1; j <= 6; j++) {
      const tag = `{{R${j}_SL}}`;
      const rep = reps[j - 1];

      if (rep) {
        // Data exists: Populate placeholders
        body.replaceText(tag, j.toString());
        body.replaceText(`{{R${j}_NAME}}`, rep.name || '');
        body.replaceText(`{{R${j}_CONTACT}}`, rep.contact || '');
      } else {
        // No data: Delete the whole row completely from the table
        removeRowByTag(body, tag);
      }
    }

    doc.saveAndClose();

    // 4. Export to PDF Blob and return Base64 string for direct browser download
    const pdfBlob = newDocCopy.getAs('application/pdf');
    const pdfFileName = 'Claim_Statement_' + (formData.corporate || 'Doc') + '.pdf';
    
    newDocCopy.setTrashed(true); // Clean up temp file

    return {
      filename: pdfFileName,
      base64: Utilities.base64Encode(pdfBlob.getBytes())
    };

  } catch (err) {
    throw new Error('PDF Generation failed: ' + err.message);
  }
}

/**
 * Safely finds a tag inside a table row and removes the entire row from the table.
 */
function removeRowByTag(body, tag) {
  const searchResult = body.findText(tag);
  if (!searchResult) return;

  let element = searchResult.getElement();

  // Traverse up the tree until we reach TableRow
  while (element && element.getType() !== DocumentApp.ElementType.TABLE_ROW) {
    element = element.getParent();
  }

  if (element) {
    const row = element.asTableRow();
    const table = row.getParent().asTable();
    const rowIndex = table.getChildIndex(row);
    table.removeRow(rowIndex); // Completely deletes the blank row
  }
}
/**
 * Helper function that locates a table row containing a placeholder tag,
 * clones it for each data item, and removes the template placeholder row.
 */
// function populateDynamicTable(body, placeholderTag, dataArray, callback) {
//   const searchCell = body.findText(placeholderTag);
//   if (!searchCell) return;

//   const templateCell = searchCell.getElement().getParent(); // TableCell
//   const templateRow = templateCell.getParent(); // TableRow
//   const table = templateRow.getParent(); // Table
//   const rowIndex = table.getChildIndex(templateRow);

//   if (dataArray && dataArray.length > 0) {
//     dataArray.forEach((dataItem, index) => {
//       // Copy the template row styling and cells
//       const newRow = templateRow.copy();
//       callback(newRow, dataItem, index);
//       table.insertTableRow(rowIndex + index + 1, newRow);
//     });
//   }

//   // Remove the initial placeholder row
//   table.removeRow(rowIndex);
// }

// /** Generate PDF directly from HTML Template */
// function generateClaimStatementPDF(formData) {
//   try {
//     // 1. Evaluate the HTML Template with Form Payload
//     const htmlTemplate = HtmlService.createTemplateFromFile('DocTemplate');
//     htmlTemplate.data = formData;
//     const evaluatedHtml = htmlTemplate.evaluate().getContent();

//     // 2. Convert HTML directly to PDF Blob
//     const blob = Utilities.newBlob(evaluatedHtml, 'text/html', 'Claim_Statement.html');
//     const pdfBlob = blob.getAs('application/pdf');
//     const pdfFileName = 'Claim_Statement_' + (formData.corporate || 'Doc') + '.pdf';

//     // 3. Return Base64 data for immediate browser download
//     return {
//       filename: pdfFileName,
//       base64: Utilities.base64Encode(pdfBlob.getBytes())
//     };

//   } catch (err) {
//     throw new Error('PDF Generation failed: ' + err.message);
//   }
// }

// function generateClaimStatementPDF(formData) {
//   try {
//     const templateFile = DriveApp.getFileById(TEMPLATE_DOC_ID);
//     const newDocCopy = templateFile.makeCopy('ClaimStatement_' + (formData.corporate || 'Doc'));
//     const doc = DocumentApp.openById(newDocCopy.getId());
//     const body = doc.getBody();

//     // 1. Replace Text Placeholders
//     body.replaceText('{{Corporate}}', formData.corporate || '');
//     body.replaceText('{{Activity_Name}}', formData.activityName || '');
//     body.replaceText('{{Address}}', formData.address || '');
//     body.replaceText('{{Letter_Date}}', formData.letterDate || '');
//     body.replaceText('{{Activity_Date}}', formData.activityDate || '');
//     body.replaceText('{{Location}}', formData.location || '');
//     body.replaceText('{{Associate_Name}}', formData.signoffName || '');
//     body.replaceText('{{Designation}}', formData.signoffDesignation || '');
//     body.replaceText('{{Phone_Number}}', formData.signoffPhone || '');

//     // 2. Fetch Native Tables
//     const tables = body.getTables();

//     if (tables.length < 4) {
//       throw new Error(`Found ${tables.length} tables. Expected 4 tables.`);
//     }

//     // 3. Append Dynamic Rows to Table 3 (Materials)
//     const matTable = tables[2];
//     if (formData.materials && formData.materials.length > 0) {
//       formData.materials.forEach((mat, idx) => {
//         const row = matTable.appendRow();
//         row.appendTableCell((idx + 1).toString());
//         row.appendTableCell(mat.item || '');
//         row.appendTableCell(mat.quantity || '');
//       });
//     }

//     // 4. Append Dynamic Rows to Table 4 (Representatives)
//     const repTable = tables[3];
//     if (formData.representatives && formData.representatives.length > 0) {
//       formData.representatives.forEach((rep, idx) => {
//         const row = repTable.appendRow();
//         row.appendTableCell((idx + 1).toString());
//         row.appendTableCell(rep.name || '');
//         row.appendTableCell(rep.contact || '');
//       });
//     }

//     doc.saveAndClose();

//     // 5. Convert to PDF Blob and return Base64 for instant device download
//     const pdfBlob = newDocCopy.getAs('application/pdf');
//     const pdfFileName = 'Claim_Statement_' + (formData.corporate || 'Doc') + '.pdf';
    
//     newDocCopy.setTrashed(true); // Clean up temp doc

//     return {
//       filename: pdfFileName,
//       base64: Utilities.base64Encode(pdfBlob.getBytes())
//     };

//   } catch (err) {
//     throw new Error('PDF Generation failed: ' + err.message);
//   }
// }
// /** Helper function to find all tables sequentially in the document */
// function findTablesRecursively(container) {
//   let tables = [];
//   const numChildren = container.getNumChildren();

//   for (let i = 0; i < numChildren; i++) {
//     const child = container.getChild(i);
//     const type = child.getType();

//     if (type === DocumentApp.ElementType.TABLE) {
//       tables.push(child.asTable());
//     } else if (child.getNumChildren) {
//       tables = tables.concat(findTablesRecursively(child));
//     }
//   }
//   return tables;
// }